import { API_KEY, BACKEND_URL } from "./client"
import type { VoiceSettings } from "@/types/api"

/**
 * Streaming TTS over WebSocket. Emits PCM16LE 24kHz chunks as the model
 * generates them, plus meta/ttfa/done JSON frames.
 */
export interface TTSStreamCallbacks {
  onMeta?: (m: { sample_rate: number; voice_id: string }) => void
  onTtfa?: (ms: number) => void
  onChunk: (pcm: ArrayBuffer) => void
  onDone?: (info: { total_chunks: number; total_wall_ms: number }) => void
  onError?: (err: string) => void
}

export interface TTSStreamHandle {
  close: () => void
}

export function startTTSStream(
  voiceId: string,
  text: string,
  cbs: TTSStreamCallbacks,
  settings?: VoiceSettings
): TTSStreamHandle {
  // Resolve absolute URL even when running through Vite dev proxy.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  const origin = BACKEND_URL || `${proto}//${window.location.host}`
  const wsUrl =
    origin.replace(/^http/, "ws") +
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}/ws` +
    (API_KEY ? `?api_key=${encodeURIComponent(API_KEY)}` : "")

  const ws = new WebSocket(wsUrl)
  ws.binaryType = "arraybuffer"
  let gotDone = false
  let closedByCaller = false

  ws.onopen = () => {
    ws.send(JSON.stringify({ text, voice_settings: settings ?? {} }))
  }
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === "meta") cbs.onMeta?.(msg)
        else if (msg.type === "ttfa") cbs.onTtfa?.(msg.ms)
        else if (msg.type === "done") {
          gotDone = true
          cbs.onDone?.(msg)
        } else if (msg.type === "error") cbs.onError?.(msg.message)
      } catch {
        // ignore
      }
    } else {
      cbs.onChunk(ev.data as ArrayBuffer)
    }
  }
  ws.onerror = () => {
    // Only surface as error if we haven't completed normally already.
    if (!gotDone && !closedByCaller) cbs.onError?.("websocket error")
  }
  ws.onclose = (ev) => {
    // 1006 (abnormal) after a normal "done" frame is just uvicorn closing
    // without a server-side close frame — not an error from the user's POV.
    if (gotDone || closedByCaller) return
    if (ev.code !== 1000 && ev.code !== 1005) cbs.onError?.(`closed: ${ev.code}`)
  }
  return {
    close: () => {
      closedByCaller = true
      ws.close()
    },
  }
}
