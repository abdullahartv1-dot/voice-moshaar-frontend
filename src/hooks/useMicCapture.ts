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
  onChunk: (pcm16le16k: ArrayBuffer) => void
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
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })
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
        cbRef.current.onChunk(data.buffer as ArrayBuffer)
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
