import * as React from "react"

/**
 * Captures microphone audio at 16 kHz mono and feeds raw PCM16LE chunks
 * to the callback. Uses AudioContext + a manual downsampler — works in
 * Chrome and Safari without an AudioWorklet file.
 *
 * Browsers default to 44.1 / 48 kHz; we resample to 16 kHz on the fly.
 */
export interface MicCapture {
  start: () => Promise<void>
  stop: () => void
  isRecording: boolean
}

const TARGET_SR = 16000

function downsampleFloat32(input: Float32Array, srcSr: number, dstSr: number): Float32Array {
  if (srcSr === dstSr) return input
  const ratio = srcSr / dstSr
  const newLen = Math.round(input.length / ratio)
  const out = new Float32Array(newLen)
  let outIdx = 0
  let inIdx = 0
  while (outIdx < newLen) {
    const nextIn = Math.min(input.length, Math.round((outIdx + 1) * ratio))
    let sum = 0
    let count = 0
    for (let i = inIdx; i < nextIn; i++) {
      sum += input[i] ?? 0
      count++
    }
    out[outIdx] = count > 0 ? sum / count : 0
    inIdx = nextIn
    outIdx++
  }
  return out
}

function floatToInt16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

export function useMicCapture(onChunk: (pcm16le16k: ArrayBuffer) => void): MicCapture {
  const ctxRef = React.useRef<AudioContext | null>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const procRef = React.useRef<ScriptProcessorNode | null>(null)
  const sourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null)
  const [isRecording, setRecording] = React.useState(false)

  // Latest callback in a ref so we don't tear down on every render.
  const cbRef = React.useRef(onChunk)
  React.useEffect(() => {
    cbRef.current = onChunk
  }, [onChunk])

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
    const src = ctx.createMediaStreamSource(stream)
    sourceRef.current = src

    // ScriptProcessorNode is deprecated but ubiquitous — sufficient for v1.
    // bufferSize 4096 at 48k = ~85ms chunks. After downsample → 16k = ~1365 samples.
    const proc = ctx.createScriptProcessor(4096, 1, 1)
    proc.onaudioprocess = (ev) => {
      const inBuf = ev.inputBuffer.getChannelData(0)
      const f32 = downsampleFloat32(inBuf, ctx.sampleRate, TARGET_SR)
      cbRef.current(floatToInt16(f32))
    }
    src.connect(proc)
    proc.connect(ctx.destination) // ScriptProcessor needs to be in the graph
    procRef.current = proc
    setRecording(true)
  }, [])

  const stop = React.useCallback(() => {
    procRef.current?.disconnect()
    sourceRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    void ctxRef.current?.close().catch(() => undefined)
    procRef.current = null
    sourceRef.current = null
    streamRef.current = null
    ctxRef.current = null
    setRecording(false)
  }, [])

  React.useEffect(() => stop, [stop])

  return { start, stop, isRecording }
}
