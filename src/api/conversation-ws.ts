import { API_KEY, BACKEND_URL } from "./client"

/**
 * Live conversation (S2S) client. Wraps a single WebSocket talking to
 * /v1/conversation/ws. Streams mic PCM up, plays back TTS PCM via the
 * provided AudioContext.
 */

export type ConvState = "idle" | "listening" | "thinking" | "speaking"

export interface ConversationCallbacks {
  onState?: (s: ConvState) => void
  onTranscript?: (userText: string) => void
  onResponseText?: (assistantText: string) => void
  onError?: (msg: string) => void
  onTurnDone?: (info: { ttfa_ms: number; total_ms: number; chunks: number }) => void
}

export interface ConversationOptions {
  voiceId?: string
  language?: string
}

interface AudioMeta {
  sample_rate: number
  format: string
}

export class ConversationClient {
  private ws: WebSocket | null = null
  private audioCtx: AudioContext | null = null
  private playbackTime = 0
  private currentMeta: AudioMeta = { sample_rate: 24000, format: "pcm_s16le" }
  private cbs: ConversationCallbacks
  private opts: Required<ConversationOptions>
  private state: ConvState = "idle"

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

    this.audioCtx = new AudioContext({ sampleRate: this.currentMeta.sample_rate })
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume()

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
        this.cbs.onError?.("websocket error")
        reject(new Error("websocket error"))
      }
      ws.onclose = (ev) => {
        if (ev.code !== 1000 && ev.code !== 1005) {
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
      case "transcript":
        this.cbs.onTranscript?.(String(msg.text ?? ""))
        this.setState("thinking")
        break
      case "response_text":
        this.cbs.onResponseText?.(String(msg.text ?? ""))
        this.setState("speaking")
        break
      case "audio_meta":
        this.currentMeta = {
          sample_rate: Number(msg.sample_rate ?? 24000),
          format: String(msg.format ?? "pcm_s16le"),
        }
        // playbackTime resets per turn — schedule from now
        this.playbackTime = this.audioCtx?.currentTime ?? 0
        break
      case "turn_done":
        this.cbs.onTurnDone?.({
          ttfa_ms: Number(msg.ttfa_ms ?? 0),
          total_ms: Number(msg.total_ms ?? 0),
          chunks: Number(msg.chunks ?? 0),
        })
        // wait for the queued audio to finish before flipping state
        setTimeout(() => this.setState("idle"), 300)
        break
      case "error":
        this.cbs.onError?.(String(msg.message ?? "error"))
        break
    }
  }

  private enqueuePCM(buf: ArrayBuffer) {
    const ctx = this.audioCtx
    if (!ctx) return
    // PCM16LE → Float32
    const i16 = new Int16Array(buf)
    if (i16.length === 0) return
    const f32 = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i]! / 32768
    const audioBuffer = ctx.createBuffer(1, f32.length, this.currentMeta.sample_rate)
    audioBuffer.copyToChannel(f32, 0)
    const src = ctx.createBufferSource()
    src.buffer = audioBuffer
    src.connect(ctx.destination)
    const startAt = Math.max(this.playbackTime, ctx.currentTime + 0.02)
    src.start(startAt)
    this.playbackTime = startAt + audioBuffer.duration
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
  }

  /** Track that the mic just opened — UI hint only. */
  startListening() {
    this.setState("listening")
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
    try {
      void this.audioCtx?.close()
    } catch {
      // ignore
    }
    this.audioCtx = null
    this.setState("idle")
  }
}
