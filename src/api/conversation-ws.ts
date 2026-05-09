import { API_KEY, BACKEND_URL } from "./client"
import { createPCMPlayer, type PCMPlayer } from "@/lib/pcm-player"

/**
 * Live conversation (S2S) client. Wraps a single WebSocket talking to
 * /v1/conversation/ws. Streams mic PCM up, plays back TTS PCM via an
 * AudioWorklet for sample-accurate gapless audio.
 */

export type ConvState = "idle" | "listening" | "thinking" | "speaking"

export interface TranscriptInfo {
  text: string
  /** Server-side turn index (1-based). Used to dedupe a `late` transcript
   * that may arrive after the response. */
  turn?: number
  /** Relative URL pointing to the user's recorded audio for this turn —
   * lets the chat UI render an inline player so the user can verify
   * what was actually sent. */
  audioUrl?: string
  /** True when the transcript landed AFTER the response (background ASR
   * path). The UI should attach it to the matching user bubble. */
  late?: boolean
}

export interface ConversationCallbacks {
  onState?: (s: ConvState) => void
  onTranscript?: (info: TranscriptInfo) => void
  onResponseText?: (assistantText: string) => void
  onError?: (msg: string) => void
  onTurnDone?: (info: { ttfa_ms: number; total_ms: number; chunks: number }) => void
  onSession?: (sessionId: string) => void
}

export interface ConversationOptions {
  voiceId?: string
  language?: string
}

export class ConversationClient {
  private ws: WebSocket | null = null
  private player: PCMPlayer | null = null
  private cbs: ConversationCallbacks
  private opts: Required<ConversationOptions>
  private state: ConvState = "idle"
  private closedByCaller = false

  constructor(cbs: ConversationCallbacks, opts: ConversationOptions = {}) {
    this.cbs = cbs
    this.opts = {
      voiceId: opts.voiceId ?? "default",
      language: opts.language ?? "ar",
    }
  }

  private setState(s: ConvState) {
    if (this.state === s) return
    this.state = s
    this.cbs.onState?.(s)
  }

  async connect(): Promise<void> {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    const origin = BACKEND_URL || `${proto}//${window.location.host}`
    const params = new URLSearchParams({
      voice_id: this.opts.voiceId,
      language: this.opts.language,
    })
    if (API_KEY) params.set("api_key", API_KEY)
    const url = origin.replace(/^http/, "ws") + `/v1/conversation/ws?${params.toString()}`

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
        if (
          !this.closedByCaller &&
          ev.code !== 1000 &&
          ev.code !== 1005 &&
          ev.code !== 1006
        ) {
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
        this.setState("idle")
        break
      case "session":
        this.cbs.onSession?.(String(msg.session_id ?? ""))
        break
      case "transcript":
        this.cbs.onTranscript?.({
          text: String(msg.text ?? ""),
          turn: typeof msg.turn === "number" ? msg.turn : undefined,
          audioUrl: typeof msg.audio_url === "string" ? msg.audio_url : undefined,
          late: Boolean(msg.late),
        })
        if (!msg.late) this.setState("thinking")
        break
      case "response_text":
        this.cbs.onResponseText?.(String(msg.text ?? ""))
        this.setState("speaking")
        break
      case "audio_meta":
        // Server-emitted meta — currently informational. The PCM player
        // is locked to 24 kHz / pcm_s16le which the backend always uses.
        break
      case "turn_done":
        this.cbs.onTurnDone?.({
          ttfa_ms: Number(msg.ttfa_ms ?? 0),
          total_ms: Number(msg.total_ms ?? 0),
          chunks: Number(msg.chunks ?? 0),
        })
        // Tell the player no more audio is coming for this turn; once the
        // worklet drains its queue we know playback finished.
        this.player?.flush()
        void this.player?.waitForDrain().then(() => this.setState("idle"))
        break
      case "error":
        this.cbs.onError?.(String(msg.message ?? "error"))
        break
    }
  }

  private enqueuePCM(buf: ArrayBuffer) {
    this.player?.pushPCM16LE(buf)
  }

  /** Send a chunk of mic PCM16LE @ 16 kHz. */
  sendAudioChunk(buf: ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf)
  }

  /** Tell the server the user finished talking — triggers ASR → LLM → TTS. */
  endOfUtterance() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "end_of_utterance" }))
      this.setState("thinking")
    }
  }

  /** Send a text message directly (skip ASR). */
  sendText(content: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "text", content }))
      this.setState("thinking")
    }
  }

  reset() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "reset" }))
    }
  }

  interrupt() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "interrupt" }))
    }
    // Drop any audio already buffered locally so the user gets immediate silence.
    this.player?.reset()
  }

  /** Track that the mic just opened — UI hint only. */
  startListening() {
    this.setState("listening")
  }

  close() {
    this.closedByCaller = true
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
    try {
      void this.player?.close()
    } catch {
      // ignore
    }
    this.player = null
    this.setState("idle")
  }
}
