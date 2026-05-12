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
    // Realtime's pcm16 output format exactly.
    this.player = await createPCMPlayer()

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
        if (!this.closedByCaller && ev.code !== 1000 && ev.code !== 1005) {
          this.cbs.onError?.(`closed: ${ev.code}`)
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

  private enqueuePCM(buf: ArrayBuffer) {
    this.player?.pushPCM16LE(buf)
  }

  /** Send a 16 kHz PCM16LE mic chunk. Upsampled here to 24 kHz to
   *  match OpenAI Realtime's input_audio_format. */
  sendAudioChunk(pcm16le16k: ArrayBuffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const upsampled = upsample16To24(pcm16le16k)
    this.ws.send(upsampled)
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

/**
 * Simple linear-interpolation upsample from 16 kHz to 24 kHz PCM16 LE.
 * 2:3 ratio — for every 2 input samples, produce 3 output samples. The
 * worklet on the pod's input side handles its own resampling; we just
 * need to land bytes in OpenAI's expected format.
 */
function upsample16To24(pcm16le: ArrayBuffer): ArrayBuffer {
  const inView = new Int16Array(pcm16le)
  const inLen = inView.length
  const outLen = Math.floor((inLen * 24000) / 16000)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const t = (i * 16000) / 24000
    const i0 = Math.floor(t)
    const i1 = Math.min(inLen - 1, i0 + 1)
    const frac = t - i0
    out[i] = Math.round(inView[i0] * (1 - frac) + inView[i1] * frac)
  }
  return out.buffer
}
