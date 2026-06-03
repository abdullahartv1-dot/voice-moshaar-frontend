/**
 * OmniVoiceCall — hybrid: Deepgram Voice Agent for STT+LLM, OmniVoice
 * (RunPod) for TTS with Sara's cloned voice.
 *
 * Pipeline:
 *   Browser mic → Deepgram Voice Agent (nova-2 STT + gpt-5.2 LLM)
 *     → assistant text via ConversationText event
 *     → forward each line to wss://<runpod>/ws/tts
 *     → PCM16 24kHz chunks back → pcm-player → speaker
 *
 *   We suppress Deepgram's own audio output (we never play its binary
 *   frames) so the user only hears the OmniVoice Sara voice — same LLM
 *   path as the Deepgram provider, just a different mouth.
 *
 * Why this shape: keeps the comparison apples-to-apples on STT+LLM (same
 * as the Deepgram provider) and isolates the variable that matters here
 * — TTS quality. The only difference users hear is Sara's voice through
 * OmniVoice's locally-running model.
 */
import { createPCMPlayer, type PCMPlayer } from "@/lib/pcm-player"
import { SARA_PROMPT, SARA_GREETING } from "@/lib/sara-prompt"

import type { RealtimeState, RealtimeTurn } from "./livekit-call"

export type { RealtimeState, RealtimeTurn }

export interface OmniVoiceCallbacks {
  onState?: (s: RealtimeState) => void
  onUserTranscript?: (text: string, final: boolean) => void
  onAssistantTranscript?: (text: string, final: boolean) => void
  onMicLevel?: (rms: number) => void
  onError?: (msg: string) => void
  onMetric?: (m: { ttfa_ms?: number; detected_language?: string }) => void
}

export interface OmniVoiceConnectOptions {
  mcpUrl?: string
  mcpKey?: string
}

interface TokenResponse {
  api_key: string
  api_key_id: string | null
  expires_in: number
}

const TOKEN_ENDPOINT =
  (import.meta.env.VITE_DEEPGRAM_TOKEN_URL as string | undefined) ||
  "/api/deepgram-token"

const DEEPGRAM_URL = "wss://agent.deepgram.com/v1/agent/converse"

// Public RunPod proxy. The user's pod-id changes if they redeploy, so
// keep this overridable via env var; default to the current pod.
const OMNIVOICE_WS_URL =
  (import.meta.env.VITE_OMNIVOICE_WS_URL as string | undefined) ||
  "wss://qrtemxwbqp6com-8000.proxy.runpod.net/ws/tts"

// Sara voice profile id, created on the OmniVoice backend from the
// VibeVoice gold reference (default.wav). If the profile is recreated,
// update this.
const SARA_VOICE_ID = "4381f3fc"

// Audio formats
const STT_SR = 16000
const TTS_SR = 24000

export class OmniVoiceCall {
  private dgWs: WebSocket | null = null
  private ovWs: WebSocket | null = null
  private cbs: OmniVoiceCallbacks
  private state: RealtimeState = "idle"
  private closedByCaller = false

  // Mic capture (sends PCM to Deepgram for STT)
  private inputCtx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private micSource: MediaStreamAudioSourceNode | null = null
  private micNode: AudioWorkletNode | null = null

  // PCM player (plays OmniVoice TTS output)
  private player: PCMPlayer | null = null

  // Metrics
  private userStoppedAt: number | null = null
  private firstAudioReceived = false
  private agentSpeaking = false
  private lastServerError: string | null = null

  // Pending TTS request — only one at a time to avoid out-of-order audio
  private ttsBusy = false
  private ttsQueue: string[] = []

  constructor(cbs: OmniVoiceCallbacks) {
    this.cbs = cbs
  }

  private setState(s: RealtimeState) {
    if (this.state === s) return
    this.state = s
    this.cbs.onState?.(s)
  }

  async connect(opts: OmniVoiceConnectOptions = {}): Promise<void> {
    void opts // MCP creds reserved for phase 2

    this.setState("connecting")

    // 1) Deepgram temp key for STT+LLM
    const tokenResp = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    if (!tokenResp.ok) {
      const body = await tokenResp.text().catch(() => "")
      throw new Error(
        `token fetch failed (${tokenResp.status}): ${body || tokenResp.statusText}`,
      )
    }
    const { api_key: dgKey } = (await tokenResp.json()) as TokenResponse
    if (!dgKey) throw new Error("Deepgram returned no api_key")

    // 2) PCM player for OmniVoice TTS output
    this.player = await createPCMPlayer()
    try {
      const silence = new Int16Array(TTS_SR * 0.1)
      this.player.pushPCM16LE(silence.buffer)
    } catch {
      // ignore
    }

    // 3) Open Deepgram Voice Agent WebSocket (STT+LLM)
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(DEEPGRAM_URL, ["token", dgKey])
      ws.binaryType = "arraybuffer"
      const t = window.setTimeout(
        () => reject(new Error("Deepgram WS open timeout (10s)")),
        10_000,
      )
      ws.onopen = () => {
        window.clearTimeout(t)
        this.dgWs = ws
        ws.send(JSON.stringify(this.buildDeepgramSettings()))
        resolve()
      }
      ws.onerror = () => {
        window.clearTimeout(t)
        reject(new Error("Deepgram WS error before open"))
      }
      ws.onmessage = (ev) => this.handleDeepgramMessage(ev)
      ws.onclose = (ev) => this.handleDeepgramClose(ev)
    })

    // 4) Open OmniVoice WebSocket for TTS
    await this.openOmniVoiceWs()

    // 5) Mic capture → Deepgram
    await this.startMicCapture()

    this.setState("listening")
  }

  private buildDeepgramSettings(): unknown {
    // STT + LLM only — TTS will be replaced by OmniVoice. We still tell
    // Deepgram to speak (it requires a speak block), but we'll suppress
    // its audio frames in handleDeepgramMessage.
    return {
      type: "Settings",
      audio: {
        input: { encoding: "linear16", sample_rate: STT_SR },
        // Tiny output config — we ignore Deepgram's audio anyway, but
        // the field is required.
        output: { encoding: "linear16", sample_rate: 8000, container: "none" },
      },
      agent: {
        language: "ar",
        listen: {
          provider: {
            type: "deepgram",
            model: "nova-2",
            language: "ar",
          },
        },
        think: {
          provider: { type: "open_ai", model: "gpt-5.2-chat-latest" },
          prompt: SARA_PROMPT,
        },
        speak: {
          // Use Deepgram's free Aura voice — we never play its output,
          // but the settings block requires a valid speak provider.
          provider: { type: "deepgram", model: "aura-2-thalia-en" },
        },
        greeting: SARA_GREETING,
      },
    }
  }

  private async openOmniVoiceWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(OMNIVOICE_WS_URL)
      ws.binaryType = "arraybuffer"
      const t = window.setTimeout(
        () => reject(new Error("OmniVoice WS open timeout (15s)")),
        15_000,
      )
      ws.onopen = () => {
        window.clearTimeout(t)
        this.ovWs = ws
        resolve()
      }
      ws.onerror = () => {
        window.clearTimeout(t)
        reject(new Error("OmniVoice WS error before open"))
      }
      ws.onmessage = (ev) => this.handleOmniVoiceMessage(ev)
      ws.onclose = (ev) => {
        if (!this.closedByCaller && ev.code !== 1000) {
          this.cbs.onError?.(
            `انقطع اتصال OmniVoice — code ${ev.code}${ev.reason ? ` (${ev.reason})` : ""}`,
          )
        }
      }
    })
  }

  private handleDeepgramMessage(ev: MessageEvent): void {
    // CRITICAL: binary frames from Deepgram = its TTS audio. We DROP it.
    // The whole point of this provider is to replace Deepgram's voice
    // with OmniVoice's Sara.
    if (ev.data instanceof ArrayBuffer) return

    if (typeof ev.data !== "string") return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(ev.data) as Record<string, unknown>
    } catch {
      return
    }

    const t = msg.type
    if (import.meta.env.DEV) console.debug("[omnivoice/dg] ←", t, msg)

    switch (t) {
      case "Welcome":
      case "SettingsApplied":
        break
      case "UserStartedSpeaking":
        // User barge-in — drop any pending OmniVoice audio
        if (this.agentSpeaking) {
          this.player?.reset()
          this.ttsQueue = []
          this.agentSpeaking = false
        }
        this.setState("listening")
        // Track for TTFA timing
        this.userStoppedAt = null
        this.firstAudioReceived = false
        break
      case "AgentThinking":
        this.setState("thinking")
        // Mark "user stopped speaking" — start TTFA timer from here
        if (this.userStoppedAt === null) {
          this.userStoppedAt = performance.now()
        }
        break
      case "AgentStartedSpeaking":
        // Deepgram is "speaking" — but we ignore its audio. We'll flip
        // to "speaking" state when OmniVoice actually starts emitting.
        break
      case "AgentAudioDone":
        // End of Deepgram's "turn". OmniVoice may still be generating.
        break
      case "ConversationText": {
        const role = msg.role as string | undefined
        const content = msg.content as string | undefined
        if (!content) break
        if (role === "user") {
          this.cbs.onUserTranscript?.(content, true)
          const lang = msg.language as string | undefined
          if (lang) this.cbs.onMetric?.({ detected_language: lang })
        } else if (role === "assistant") {
          this.cbs.onAssistantTranscript?.(content, true)
          // Send to OmniVoice for TTS
          this.queueTTS(content)
        }
        break
      }
      case "Error":
      case "Warning": {
        const detail = (msg.description ||
          msg.message ||
          msg.reason ||
          JSON.stringify(msg)) as string
        this.lastServerError = detail
        if (t === "Error") this.cbs.onError?.(`Deepgram: ${detail}`)
        else console.warn("[omnivoice/dg] warning:", detail)
        break
      }
    }
  }

  private queueTTS(text: string): void {
    this.ttsQueue.push(text)
    void this.drainTTSQueue()
  }

  private async drainTTSQueue(): Promise<void> {
    if (this.ttsBusy) return
    const text = this.ttsQueue.shift()
    if (!text) return
    if (!this.ovWs || this.ovWs.readyState !== WebSocket.OPEN) {
      // Try reopening if dropped
      try {
        await this.openOmniVoiceWs()
      } catch (e) {
        this.cbs.onError?.(`OmniVoice reconnect failed: ${(e as Error).message}`)
        return
      }
    }
    this.ttsBusy = true
    try {
      this.ovWs!.send(
        JSON.stringify({
          text,
          voice: SARA_VOICE_ID,
          language: "ar",
          emo_alpha: 1.0,
          speed: 1.0,
        }),
      )
    } catch (e) {
      this.cbs.onError?.(`OmniVoice send failed: ${(e as Error).message}`)
      this.ttsBusy = false
    }
  }

  private handleOmniVoiceMessage(ev: MessageEvent): void {
    if (ev.data instanceof ArrayBuffer && this.player) {
      // PCM16 24kHz from OmniVoice
      if (!this.firstAudioReceived && this.userStoppedAt !== null) {
        const ttfa = Math.round(performance.now() - this.userStoppedAt)
        this.firstAudioReceived = true
        this.cbs.onMetric?.({ ttfa_ms: ttfa })
      }
      if (this.state !== "speaking") this.setState("speaking")
      this.agentSpeaking = true
      this.player.pushPCM16LE(ev.data)
      return
    }
    if (typeof ev.data !== "string") return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(ev.data) as Record<string, unknown>
    } catch {
      return
    }
    const t = msg.type
    if (import.meta.env.DEV) console.debug("[omnivoice/ov] ←", t, msg)
    if (t === "done") {
      this.ttsBusy = false
      // Process next queued line if any
      void this.drainTTSQueue()
      // If no more queued, return to listening
      if (this.ttsQueue.length === 0) {
        this.agentSpeaking = false
        this.setState("listening")
      }
    } else if (t === "error") {
      this.cbs.onError?.(`OmniVoice: ${msg.detail || JSON.stringify(msg)}`)
      this.ttsBusy = false
      void this.drainTTSQueue()
    }
  }

  private handleDeepgramClose(ev: CloseEvent): void {
    if (!this.closedByCaller && ev.code !== 1000) {
      const parts: string[] = [`code ${ev.code}`]
      if (ev.reason) parts.push(ev.reason)
      if (this.lastServerError) parts.push(this.lastServerError)
      this.cbs.onError?.(`انقطع الاتصال — ${parts.join(" — ")}`)
    }
    this.setState("idle")
  }

  private async startMicCapture(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })
    this.micStream = stream

    const ctx = new AudioContext()
    if (ctx.state === "suspended") await ctx.resume()
    await ctx.audioWorklet.addModule("/mic-capture-worklet.js")
    this.inputCtx = ctx

    const source = ctx.createMediaStreamSource(stream)
    this.micSource = source
    const node = new AudioWorkletNode(ctx, "mic-capture-processor", {
      processorOptions: { vadThreshold: 0.012, vadHysteresisMs: 80 },
    })
    this.micNode = node

    node.port.onmessage = (ev) => {
      const m = ev.data
      if (!m) return
      if (
        m.type === "chunk" &&
        m.buffer &&
        this.dgWs?.readyState === WebSocket.OPEN
      ) {
        this.dgWs.send(m.buffer as ArrayBuffer)
        if (typeof m.rms === "number") this.cbs.onMicLevel?.(m.rms)
      } else if (m.type === "vad" && typeof m.rms === "number") {
        this.cbs.onMicLevel?.(m.rms)
      }
    }

    source.connect(node)
  }

  async close(): Promise<void> {
    this.closedByCaller = true

    // Tear down both WebSockets
    if (this.dgWs) {
      try {
        if (this.dgWs.readyState === WebSocket.OPEN) {
          this.dgWs.send(JSON.stringify({ type: "Close" }))
        }
        this.dgWs.close(1000, "client closed")
      } catch {
        // ignore
      }
      this.dgWs = null
    }
    if (this.ovWs) {
      try {
        this.ovWs.close(1000, "client closed")
      } catch {
        // ignore
      }
      this.ovWs = null
    }

    // Mic
    if (this.micNode) {
      try {
        this.micNode.port.onmessage = null
        this.micNode.disconnect()
      } catch {
        // ignore
      }
      this.micNode = null
    }
    if (this.micSource) {
      try {
        this.micSource.disconnect()
      } catch {
        // ignore
      }
      this.micSource = null
    }
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) {
        try {
          t.stop()
        } catch {
          // ignore
        }
      }
      this.micStream = null
    }
    if (this.inputCtx) {
      try {
        await this.inputCtx.close()
      } catch {
        // ignore
      }
      this.inputCtx = null
    }

    // Player
    if (this.player) {
      try {
        this.player.reset()
        await this.player.close()
      } catch {
        // ignore
      }
      this.player = null
    }

    this.ttsQueue = []
    this.ttsBusy = false
    this.setState("idle")
  }
}
