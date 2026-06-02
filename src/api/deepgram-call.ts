/**
 * DeepgramCall — talks to Deepgram's Voice Agent WebSocket directly from
 * the browser. Mirrors the LiveKitCall interface (same callback shape,
 * same lifecycle) so the /calls page can swap providers behind one
 * boolean.
 *
 * Pipeline:
 *   Browser mic → MicCaptureProcessor worklet → PCM16LE 16 kHz mono
 *     → ws.send(binaryAudio)
 *   ws.binary (PCM16LE 24 kHz mono from ElevenLabs) → PCMPlayer worklet
 *     → speaker
 *   ws.json events drive state (listening/thinking/speaking) and
 *   surface transcripts.
 *
 * Auth: temp Deepgram key fetched from /api/deepgram-token. We pass it
 * as a WebSocket subprotocol pair because the browser WebSocket API
 * doesn't let you set arbitrary headers — Deepgram explicitly supports
 * the ["token", "<key>"] subprotocol convention.
 *
 * Provider matching with LiveKit, for fair comparison:
 *   STT   : Deepgram nova-3 multilingual          (same family as LiveKit)
 *   LLM   : OpenAI gpt-4o                         (closest available)
 *   TTS   : ElevenLabs eleven_multilingual_v2     (identical model + voice)
 *   Voice : cgSgspJ2msm6clMCkdW9                  (identical voice id)
 *
 * Phase-1 scope: voice quality + responsiveness only. MCP tool calling
 * is NOT wired in this path yet (LiveKit has it). The Sara prompt still
 * describes the tools — Deepgram will narrate what it would do but
 * can't execute, so what you're really comparing is STT/LLM/TTS latency
 * and turn-taking quality, not feature parity.
 */
import { createPCMPlayer, type PCMPlayer } from "@/lib/pcm-player"
import { SARA_PROMPT, SARA_GREETING } from "@/lib/sara-prompt"

import type { RealtimeState, RealtimeTurn } from "./livekit-call"

// Re-export so callers don't need to know which file the types live in.
export type { RealtimeState, RealtimeTurn }

export interface DeepgramCallbacks {
  onState?: (s: RealtimeState) => void
  onUserTranscript?: (text: string, final: boolean) => void
  onAssistantTranscript?: (text: string, final: boolean) => void
  onMicLevel?: (rms: number) => void
  onError?: (msg: string) => void
  /**
   * Time-to-first-audio in ms. Measured from the last user-stopped-
   * speaking event to the first byte of agent audio. The thing the
   * comparison is really about.
   */
  onMetric?: (m: { ttfa_ms?: number; detected_language?: string }) => void
}

export interface DeepgramConnectOptions {
  /** Forward for parity with LiveKit — phase 1 ignores these (no MCP). */
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

const AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"

// Match LiveKit exactly so the comparison is about platforms, not models.
const VOICE_ID = "cgSgspJ2msm6clMCkdW9"
const TTS_MODEL_ID = "eleven_multilingual_v2"
const STT_MODEL = "nova-3"
const LLM_MODEL = "gpt-4o"

// Sample rates. The mic worklet hands us 16 kHz Int16LE chunks; the
// player worklet expects 24 kHz Float32 chunks (we convert in here).
const STT_SR = 16000
const TTS_SR = 24000

export class DeepgramCall {
  private ws: WebSocket | null = null
  private cbs: DeepgramCallbacks
  private state: RealtimeState = "idle"
  private closedByCaller = false

  // Audio in (mic)
  private inputCtx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private micSource: MediaStreamAudioSourceNode | null = null
  private micNode: AudioWorkletNode | null = null

  // Audio out (agent)
  private player: PCMPlayer | null = null

  // Metrics
  private userStoppedAt: number | null = null
  private firstAudioReceived = false

  // For interruption support — drop pending audio when user starts talking
  private agentSpeaking = false

  constructor(cbs: DeepgramCallbacks) {
    this.cbs = cbs
  }

  private setState(s: RealtimeState) {
    if (this.state === s) return
    this.state = s
    this.cbs.onState?.(s)
  }

  async connect(opts: DeepgramConnectOptions = {}): Promise<void> {
    void opts // phase-1: MCP creds reserved for phase-2 function calling

    this.setState("connecting")

    // 1) Temp API key from our Vercel function.
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
    const { api_key: apiKey } = (await tokenResp.json()) as TokenResponse
    if (!apiKey) throw new Error("Deepgram returned no api_key")

    // 2) Start the PCM player (warmed with 100 ms of silence so iOS
    // doesn't drop the first agent chunk).
    this.player = await createPCMPlayer()
    try {
      const silence = new Int16Array(TTS_SR * 0.1)
      this.player.pushPCM16LE(silence.buffer)
    } catch {
      // ignore — non-fatal
    }

    // 3) Open the WebSocket. Subprotocol pair is Deepgram's documented
    // way to pass the API key from a browser, since the standard
    // WebSocket constructor can't set Authorization headers.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(AGENT_URL, ["token", apiKey])
      ws.binaryType = "arraybuffer"

      const timer = window.setTimeout(() => {
        reject(new Error("Deepgram WebSocket open timeout (10s)"))
      }, 10_000)

      ws.onopen = () => {
        window.clearTimeout(timer)
        this.ws = ws
        // Settings must be the FIRST message we send. Voice Agent rejects
        // any audio frame that arrives before SettingsApplied lands.
        ws.send(JSON.stringify(this.buildSettings()))
        resolve()
      }
      ws.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error("Deepgram WebSocket error before open"))
      }
      ws.onmessage = (ev) => void this.handleMessage(ev)
      ws.onclose = (ev) => this.handleClose(ev)
    })

    // 4) Mic capture once the socket is talking. We don't actually start
    // sending audio until SettingsApplied fires (handleMessage will flip
    // the gate), so the agent's first message is always its greeting.
    await this.startMicCapture()

    this.setState("listening")
  }

  private buildSettings(): unknown {
    // Mirror of LiveKit's agent.py inference config + Sara persona. If
    // you change models/voice here, change them there too — that's
    // the whole point of the comparison.
    //
    // Language: forced to "ar" because nova-3 multi auto-detect routes
    // colloquial Saudi/Khaleeji input to Hindi/Urdu surprisingly often
    // (both write right-to-left and share phonetics with parts of
    // Arabic in some regional accents). LiveKit's agent.py uses
    // language="ar-SA" — we match. Switch back to "multi" when we add
    // the multilingual Hajj use case and let the user pick.
    return {
      type: "Settings",
      audio: {
        input: { encoding: "linear16", sample_rate: STT_SR },
        output: { encoding: "linear16", sample_rate: TTS_SR, container: "none" },
      },
      agent: {
        language: "ar",
        listen: {
          provider: {
            type: "deepgram",
            model: STT_MODEL,
            language: "ar",
          },
        },
        think: {
          provider: { type: "open_ai", model: LLM_MODEL, temperature: 0.3 },
          prompt: SARA_PROMPT,
        },
        speak: {
          provider: {
            type: "eleven_labs",
            model_id: TTS_MODEL_ID,
            voice_id: VOICE_ID,
          },
        },
        greeting: SARA_GREETING,
      },
    }
  }

  private async startMicCapture(): Promise<void> {
    // Match what LiveKit's room captures: echoCancel + noiseSup + AGC.
    // Without these, agent latency feels worse because the model wastes
    // time on user echo from its own speaker.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })
    this.micStream = stream

    // Browser audio runs at the device's native rate (usually 48000).
    // The mic worklet downsamples internally to 16 kHz before posting
    // chunks — this is the same path /call uses.
    const ctx = new AudioContext()
    if (ctx.state === "suspended") await ctx.resume()
    await ctx.audioWorklet.addModule("/mic-capture-worklet.js")
    this.inputCtx = ctx

    const source = ctx.createMediaStreamSource(stream)
    this.micSource = source
    const node = new AudioWorkletNode(ctx, "mic-capture-processor", {
      processorOptions: {
        vadThreshold: 0.012,
        vadHysteresisMs: 80,
      },
    })
    this.micNode = node

    node.port.onmessage = (ev) => {
      const msg = ev.data
      if (!msg) return
      if (msg.type === "chunk" && msg.buffer && this.ws?.readyState === WebSocket.OPEN) {
        // Forward raw PCM16LE to Deepgram. Buffer ownership was already
        // transferred by the worklet (so this is cheap).
        this.ws.send(msg.buffer as ArrayBuffer)

        // Surface mic level for the orb.
        if (typeof msg.rms === "number") this.cbs.onMicLevel?.(msg.rms)

        // VAD edge: user stopped speaking → start TTFA timer.
        if (msg.speaking === false && this.userStoppedAt === null) {
          this.userStoppedAt = performance.now()
        } else if (msg.speaking === true) {
          // Resetting on the leading edge of a new utterance lets us
          // measure the LATEST turn's latency, not the first one of the
          // call.
          this.userStoppedAt = null
          this.firstAudioReceived = false
        }
      } else if (msg.type === "vad") {
        // Already handled above for chunks; vad-only edge events still
        // give us a mic level for the orb.
        if (typeof msg.rms === "number") this.cbs.onMicLevel?.(msg.rms)
      }
    }

    source.connect(node)
    // We deliberately don't connect `node` to ctx.destination — that
    // would route the mic back into the speakers (feedback). The
    // worklet only emits via its port, not its audio output.
  }

  private async handleMessage(ev: MessageEvent): Promise<void> {
    if (typeof ev.data === "string") {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>
      } catch {
        return
      }
      this.handleEvent(msg)
      return
    }

    // Binary frame = PCM16LE 24 kHz mono from ElevenLabs (via Deepgram).
    if (ev.data instanceof ArrayBuffer && this.player) {
      // First audio of this turn → emit TTFA metric, flip orb state.
      if (!this.firstAudioReceived && this.userStoppedAt !== null) {
        const ttfa = Math.round(performance.now() - this.userStoppedAt)
        this.firstAudioReceived = true
        this.cbs.onMetric?.({ ttfa_ms: ttfa })
      }
      if (this.state !== "speaking") this.setState("speaking")
      this.agentSpeaking = true
      this.player.pushPCM16LE(ev.data)
    }
  }

  private handleEvent(msg: Record<string, unknown>) {
    const t = msg.type
    switch (t) {
      case "Welcome":
        // Server's hello — settings ack will follow.
        break

      case "SettingsApplied":
        // We're good to send audio now. (We already started — that's
        // okay; Deepgram queues until ready.)
        break

      case "UserStartedSpeaking":
        // User barge-in: drop any pending agent audio so we don't talk
        // over them. Matches LiveKit's allow_interruptions=true behavior.
        if (this.agentSpeaking) {
          this.player?.reset()
          this.agentSpeaking = false
        }
        this.setState("listening")
        break

      case "AgentThinking":
        this.setState("thinking")
        break

      case "AgentStartedSpeaking":
        this.setState("speaking")
        break

      case "AgentAudioDone":
        this.agentSpeaking = false
        this.setState("listening")
        break

      case "ConversationText": {
        const role = msg.role as string | undefined
        const content = msg.content as string | undefined
        if (!content) break
        if (role === "user") {
          this.cbs.onUserTranscript?.(content, true)
          // Detected language (Deepgram sometimes annotates on user msgs)
          const lang = msg.language as string | undefined
          if (lang) this.cbs.onMetric?.({ detected_language: lang })
        } else if (role === "assistant") {
          this.cbs.onAssistantTranscript?.(content, true)
        }
        break
      }

      case "Error":
      case "Warning": {
        const detail = (msg.description || msg.message || JSON.stringify(msg)) as string
        if (t === "Error") this.cbs.onError?.(`Deepgram: ${detail}`)
        else console.warn("[deepgram] warning:", detail)
        break
      }

      default:
        // Unknown / future event — log for telemetry, don't error.
        if (import.meta.env.DEV) {
          console.debug("[deepgram] unhandled event:", t, msg)
        }
    }
  }

  private handleClose(ev: CloseEvent) {
    if (!this.closedByCaller) {
      // 1000 = normal closure (server-initiated shutdown OK), anything
      // else is unexpected.
      if (ev.code !== 1000) {
        this.cbs.onError?.(
          `انقطع الاتصال — حاول من جديد. (code ${ev.code})`,
        )
      }
    }
    this.setState("idle")
  }

  async close(): Promise<void> {
    this.closedByCaller = true

    // Tear down WebSocket.
    if (this.ws) {
      try {
        // Send a polite close message so Deepgram stops billing immediately.
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "Close" }))
        }
        this.ws.close(1000, "client closed")
      } catch {
        // ignore
      }
      this.ws = null
    }

    // Tear down mic capture.
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

    // Tear down player.
    if (this.player) {
      try {
        this.player.reset()
        await this.player.close()
      } catch {
        // ignore
      }
      this.player = null
    }

    this.setState("idle")
  }
}
