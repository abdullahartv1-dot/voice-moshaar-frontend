import { API_KEY, BACKEND_URL } from "./client"
import { createPCMPlayer, type PCMPlayer } from "@/lib/pcm-player"

/**
 * Realtime client — talks to our pod's /v1/realtime/ws proxy which sits
 * between the browser and OpenAI's Realtime API.
 *
 * Why we don't connect to OpenAI directly: the pod injects the user's
 * Moshaar MCP tools into the session.update message, and we don't ever
 * expose the OpenAI key to the browser.
 *
 * Audio: 24 kHz PCM16 mono in both directions (OpenAI's default).
 * Mic capture is still 16 kHz, so the page upsamples before send.
 */

export type RealtimeState = "idle" | "connecting" | "listening" | "thinking" | "speaking"

export interface RealtimeTurn {
  role: "user" | "assistant"
  text: string
  ts: number
  /** True while the AI is still streaming this assistant message. */
  partial?: boolean
}

export interface RealtimeCallbacks {
  onState?: (s: RealtimeState) => void
  onUserTranscript?: (text: string) => void
  onAssistantTextDelta?: (delta: string) => void
  onAssistantTextDone?: (full: string) => void
  onToolCallStarted?: (tool: string) => void
  onToolResult?: (tool: string, ok: boolean) => void
  onError?: (msg: string) => void
}

export interface RealtimeOptions {
  mcpUrl?: string
  mcpKey?: string
}

export class RealtimeClient {
  private ws: WebSocket | null = null
  private player: PCMPlayer | null = null
  private cbs: RealtimeCallbacks
  private opts: Required<RealtimeOptions>
  private state: RealtimeState = "idle"
  private closedByCaller = false

  constructor(cbs: RealtimeCallbacks, opts: RealtimeOptions = {}) {
    this.cbs = cbs
    this.opts = {
      mcpUrl: opts.mcpUrl ?? "",
      mcpKey: opts.mcpKey ?? "",
    }
  }

  private setState(s: RealtimeState) {
    if (this.state === s) return
    this.state = s
    this.cbs.onState?.(s)
  }

  async connect(): Promise<void> {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    const origin = BACKEND_URL || `${proto}//${window.location.host}`
    const params = new URLSearchParams()
    if (API_KEY) params.set("api_key", API_KEY)
    if (this.opts.mcpUrl) params.set("mcp_url", this.opts.mcpUrl)
    if (this.opts.mcpKey) params.set("mcp_key", this.opts.mcpKey)
    const url = origin.replace(/^http/, "ws") + `/v1/realtime/ws?${params.toString()}`

    this.setState("connecting")
    // PCMPlayer is hardcoded to 24 kHz — happens to match OpenAI
    // Realtime's pcm16 output format exactly. createPCMPlayer also
    // resumes a suspended AudioContext, but iOS Safari sometimes
    // needs an extra nudge — we play a tiny silent buffer below to
    // make sure the audio output is actually unlocked before any real
    // audio arrives.
    this.player = await createPCMPlayer()
    // 100 ms of silence to "warm" the audio output device. Without
    // this, the first real audio chunk on iOS Safari can be dropped.
    try {
      const silence = new Int16Array(24000 * 0.1)
      this.player.pushPCM16LE(silence.buffer)
    } catch {
      // ignore
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.binaryType = "arraybuffer"
      ws.onopen = () => {
        this.ws = ws
      }
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data)
            this.handleJSON(msg, resolve)
          } catch {
            // ignore
          }
        } else {
          this.enqueuePCM(ev.data as ArrayBuffer)
        }
      }
      ws.onerror = () => {
        if (this.closedByCaller) return
        this.cbs.onError?.("websocket error")
        reject(new Error("websocket error"))
      }
      ws.onclose = (ev) => {
        // Match conversation-ws: silence the expected disconnect codes
        // so the user never sees "closed: 1011" or "closed: 1006" when
        // they just put the phone in their pocket or switched tabs.
        const isExpected = (
          this.closedByCaller ||
          ev.code === 1000 || ev.code === 1001 ||
          ev.code === 1005 || ev.code === 1006 ||
          ev.code === 1011 || ev.code === 1012 || ev.code === 1013
        )
        if (!isExpected) {
          this.cbs.onError?.(`closed: ${ev.code}`)
        } else {
          console.log(`[realtime-ws] closed (expected): code=${ev.code}`)
        }
        this.setState("idle")
        this.ws = null
      }
    })
  }

  private handleJSON(msg: Record<string, unknown>, onReady: () => void) {
    switch (msg.type) {
      case "ready":
        onReady()
        this.setState("listening")
        break
      case "vad_speech_started":
        this.setState("listening")
        break
      case "vad_speech_stopped":
        this.setState("thinking")
        break
      case "user_transcript":
        this.cbs.onUserTranscript?.(String(msg.text ?? ""))
        break
      case "assistant_text_delta":
        this.cbs.onAssistantTextDelta?.(String(msg.text ?? ""))
        this.setState("speaking")
        break
      case "assistant_text_done":
        this.cbs.onAssistantTextDone?.(String(msg.text ?? ""))
        break
      case "tool_call_started":
        this.cbs.onToolCallStarted?.(String(msg.tool ?? ""))
        break
      case "tool_result":
        this.cbs.onToolResult?.(
          String(msg.tool ?? ""),
          Boolean(msg.ok),
        )
        break
      case "response_done":
        // Audio drain → idle
        void this.player?.waitForDrain().then(() => this.setState("listening"))
        break
      case "error":
        this.cbs.onError?.(String(msg.message ?? "error"))
        break
    }
  }

  private audioByteCount = 0
  private audioChunkCount = 0

  private enqueuePCM(buf: ArrayBuffer) {
    if (!this.player) {
      console.warn("[realtime] received audio but PCMPlayer is null")
      return
    }
    this.audioChunkCount += 1
    this.audioByteCount += buf.byteLength
    // Log every 25 chunks so we can spot stalls in the browser console.
    if (this.audioChunkCount % 25 === 0) {
      console.log(
        `[realtime] played ${this.audioChunkCount} audio chunks ` +
          `(${(this.audioByteCount / 1024).toFixed(1)} KB total)`,
      )
    }
    this.player.pushPCM16LE(buf)
  }

  /** Send a 16 kHz PCM16LE mic chunk straight through — the backend
   *  now uses Whisper which prefers 16 kHz natively. (Old code
   *  upsampled to 24 kHz for OpenAI Realtime; that backend is gone.) */
  sendAudioChunk(pcm16le16k: ArrayBuffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(pcm16le16k)
  }

  /** Tell the server the user finished speaking — server-side VAD
   *  often catches this on its own, but a manual commit is useful
   *  for push-to-talk-style UIs. */
  commitTurn() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "commit" }))
      this.setState("thinking")
    }
  }

  cancelTurn() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancel" }))
    }
    this.player?.reset()
  }

  /** Send a typed message (no audio). */
  sendText(content: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "text", content }))
      this.setState("thinking")
    }
  }

  close() {
    this.closedByCaller = true
    try { this.ws?.close() } catch {/* ignore */}
    this.ws = null
    try { void this.player?.close() } catch {/* ignore */}
    this.player = null
    this.setState("idle")
  }
}

