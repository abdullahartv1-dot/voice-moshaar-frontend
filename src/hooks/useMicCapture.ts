import * as React from "react"

/**
 * Captures microphone audio at 16 kHz mono via an AudioWorklet, fires
 * PCM16LE chunks (~64 ms each) to onChunk, and exposes a VAD signal that
 * fires when the user starts/stops speaking.
 *
 * Worklet upgrade vs the previous ScriptProcessorNode:
 * - Capture runs on the audio thread → no main-thread jank under load
 * - Sample-accurate downsampling (linear interpolation, not block-averaged)
 * - VAD computed alongside capture instead of per-chunk in JS
 */
export interface MicCaptureOptions {
  /** Fires for every captured chunk. `speaking` is the per-chunk VAD result
   * — true when this 64 ms window is above the energy threshold. `rms` is
   * the raw RMS energy in [0, ~1] — useful for driving smooth voice-
   * reactive UI like the call-screen orb. The host can use `speaking` to
   * track when the user was *last* vocalising for the patient silence-
   * based EOU. */
  onChunk: (pcm16le16k: ArrayBuffer, speaking: boolean, rms: number) => void
  /** Fires only on idle ↔ speaking transitions — useful for orb / state UI. */
  onSpeakingChange?: (speaking: boolean) => void
  vadThreshold?: number
}

export interface MicCapture {
  start: () => Promise<void>
  stop: () => void
  isRecording: boolean
}

const WORKLET_URL = "/mic-capture-worklet.js"

export function useMicCapture(opts: MicCaptureOptions): MicCapture {
  const ctxRef = React.useRef<AudioContext | null>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const nodeRef = React.useRef<AudioWorkletNode | null>(null)
  const sourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null)
  const [isRecording, setRecording] = React.useState(false)

  // Stable refs so we don't re-create the audio graph on every render.
  const cbRef = React.useRef(opts)
  React.useEffect(() => {
    cbRef.current = opts
  }, [opts])

  const start = React.useCallback(async () => {
    if (streamRef.current) return
    // First try with our preferred constraints. If the browser can't
    // satisfy them (e.g. no mono input on this device), retry with
    // `audio: true` — any audio device the OS exposes.
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation + noise suppression help in everyday
          // rooms. Auto Gain Control is intentionally OFF: AGC on
          // mobile Chrome compresses Arabic speech aggressively
          // (chops sibilants and vowel onsets, which then trips
          // Whisper's "silent / non-Arabic" rejection). Without AGC
          // the captured audio is closer to what reaches our ears
          // and STT transcribes more accurately.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1,
          // Request a high source rate so the worklet has more bits
          // to work with when downsampling to 16 kHz. Most modern
          // mics deliver 48 kHz natively; if the device can't honor
          // this, the browser falls back silently.
          sampleRate: 48000,
        },
      })
    } catch (err) {
      const e = err as DOMException
      if (e.name === "OverconstrainedError" || e.name === "ConstraintNotSatisfiedError") {
        // Retry with the most permissive constraint
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } else if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
        throw new Error(
          "لا يوجد ميكروفون متصل بهذا الجهاز. المكالمة المباشرة تتطلب جهازاً فيه ميكروفون. " +
            "افتح الصفحة من جهاز آخر (لابتوب / جوال) متصل بنفس الشبكة."
        )
      } else if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
        throw new Error(
          "تم رفض الميكروفون. اسمح للموقع بالوصول للميكروفون من إعدادات المتصفح ثم أعد المحاولة."
        )
      } else if (e.name === "NotReadableError") {
        throw new Error(
          "الميكروفون قيد الاستخدام من تطبيق آخر. أغلق التطبيقات الأخرى وحاول مجدداً."
        )
      } else {
        throw new Error(`تعذّر فتح الميكروفون: ${e.message || e.name}`)
      }
    }
    streamRef.current = stream

    const ctx = new AudioContext()
    ctxRef.current = ctx
    await ctx.audioWorklet.addModule(WORKLET_URL)

    const node = new AudioWorkletNode(ctx, "mic-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0, // we don't route audio back to speakers
      processorOptions: {
        vadThreshold: opts.vadThreshold ?? 0.012,
      },
    })
    node.port.onmessage = (ev) => {
      const data = ev.data
      if (!data) return
      if (data.type === "chunk") {
        cbRef.current.onChunk(data.buffer as ArrayBuffer, Boolean(data.speaking))
      } else if (data.type === "vad") {
        cbRef.current.onSpeakingChange?.(Boolean(data.speaking))
      }
    }
    nodeRef.current = node

    const src = ctx.createMediaStreamSource(stream)
    sourceRef.current = src
    // Worklet has no outputs; connecting a source pumps audio into it.
    src.connect(node)
    setRecording(true)
  }, [opts.vadThreshold])

  const stop = React.useCallback(() => {
    nodeRef.current?.port.close()
    nodeRef.current?.disconnect()
    sourceRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    void ctxRef.current?.close().catch(() => undefined)
    nodeRef.current = null
    sourceRef.current = null
    streamRef.current = null
    ctxRef.current = null
    setRecording(false)
  }, [])

  React.useEffect(() => stop, [stop])

  return { start, stop, isRecording }
}
