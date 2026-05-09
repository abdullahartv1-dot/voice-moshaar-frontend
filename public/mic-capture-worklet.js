/**
 * Mic Capture Worklet — captures mic at the AudioContext sample rate,
 * downsamples to 16 kHz mono, and posts PCM16LE chunks back to the host.
 *
 * Replaces the deprecated ScriptProcessorNode with sample-accurate
 * audio thread capture (no main-thread jank, no glitches under load).
 *
 * Posts:
 *   { type: "chunk", buffer: ArrayBuffer (Int16LE) }
 *   { type: "vad", rms: number, speaking: boolean }
 */

const TARGET_SR = 16000
const CHUNK_SAMPLES = 1024 // ~64ms at 16kHz → low-latency, low overhead

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = options?.processorOptions || {}
    this.srcSr = sampleRate // worklet global
    this.dstSr = TARGET_SR
    this.ratio = this.srcSr / this.dstSr
    // Output buffer accumulates downsampled samples until we hit CHUNK_SAMPLES
    this.outBuf = new Float32Array(CHUNK_SAMPLES)
    this.outIdx = 0
    // Resample state
    this.acc = 0     // fractional position in source samples
    this.lastSrc = 0 // for linear interpolation continuity
    // VAD state
    this.vadThreshold = opts.vadThreshold ?? 0.012
    this.vadHysteresis = opts.vadHysteresisMs ?? 80
    this.vadFramesSpoken = 0
    this.lastSpeaking = false
  }

  /** Linear interpolation downsampler — better than averaging for speech. */
  resampleAndPush(input) {
    const src = input
    const inverse = this.dstSr / this.srcSr
    let i = 0
    while (i < src.length) {
      // Read a sample at fractional position `acc`
      const srcPos = this.acc
      const i0 = Math.floor(srcPos)
      const frac = srcPos - i0
      // Pull two source samples; interpolate
      const s0 = i0 < src.length ? src[i0] : this.lastSrc
      const s1 = i0 + 1 < src.length ? src[i0 + 1] : s0
      this.outBuf[this.outIdx++] = s0 + (s1 - s0) * frac
      if (this.outIdx >= CHUNK_SAMPLES) {
        this.flush()
      }
      this.acc += this.ratio
      if (this.acc >= src.length) {
        this.lastSrc = src[src.length - 1] ?? 0
        this.acc -= src.length
        i = src.length
      } else if (this.acc >= i + 1) {
        i = Math.floor(this.acc)
      }
    }
  }

  flush() {
    // Compute RMS for VAD
    let sumSq = 0
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      const s = this.outBuf[i]
      sumSq += s * s
    }
    const rms = Math.sqrt(sumSq / CHUNK_SAMPLES)
    const speaking = rms > this.vadThreshold
    if (speaking !== this.lastSpeaking) {
      this.port.postMessage({ type: "vad", rms, speaking })
      this.lastSpeaking = speaking
    }

    // Convert to PCM16LE
    const i16 = new Int16Array(CHUNK_SAMPLES)
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      const s = Math.max(-1, Math.min(1, this.outBuf[i]))
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    // Transfer ownership of the underlying buffer to avoid copying.
    this.port.postMessage({ type: "chunk", buffer: i16.buffer }, [i16.buffer])

    // Reset
    this.outBuf = new Float32Array(CHUNK_SAMPLES)
    this.outIdx = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length > 0) {
      this.resampleAndPush(ch)
    }
    return true
  }
}

registerProcessor("mic-capture-processor", MicCaptureProcessor)
