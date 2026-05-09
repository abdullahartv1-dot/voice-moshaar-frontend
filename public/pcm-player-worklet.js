/**
 * PCM Player Worklet — gapless 24 kHz Float32 audio playback.
 *
 * Receives Float32Array chunks via worklet messages and plays them
 * continuously with sample-accurate scheduling. No gaps between chunks
 * (vs ScheduleBufferSource which has ~10-30ms drift on long streams).
 *
 * Messages:
 *   { type: "push", chunk: Float32Array }   ← enqueue audio
 *   { type: "flush" }                       ← stop after current buffer
 *   { type: "reset" }                       ← drop everything immediately
 *
 * Posts back:
 *   { type: "underrun" }                    ← when queue ran dry
 */

class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []           // ring of Float32Array chunks
    this.queueLen = 0         // total samples queued
    this.readIdx = 0          // index into queue[0]
    this.flushing = false
    this.silentStreak = 0
    this.port.onmessage = (ev) => this.handle(ev.data)
  }

  handle(msg) {
    if (!msg) return
    if (msg.type === "push" && msg.chunk) {
      this.queue.push(msg.chunk)
      this.queueLen += msg.chunk.length
      this.flushing = false
    } else if (msg.type === "flush") {
      this.flushing = true
    } else if (msg.type === "reset") {
      this.queue.length = 0
      this.queueLen = 0
      this.readIdx = 0
      this.flushing = false
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    const N = out.length
    let written = 0

    while (written < N && this.queue.length > 0) {
      const head = this.queue[0]
      const remaining = head.length - this.readIdx
      const need = N - written
      const copy = Math.min(remaining, need)

      out.set(head.subarray(this.readIdx, this.readIdx + copy), written)
      written += copy
      this.readIdx += copy
      this.queueLen -= copy

      if (this.readIdx >= head.length) {
        this.queue.shift()
        this.readIdx = 0
      }
    }

    // Pad remainder with silence
    if (written < N) {
      out.fill(0, written)
      // Notify host once when underrun starts (queue empty AND silence requested)
      if (this.queueLen === 0 && this.silentStreak === 0) {
        this.port.postMessage({ type: "underrun" })
      }
      this.silentStreak += N - written
    } else {
      this.silentStreak = 0
    }

    // Stay alive — never return false (host owns lifecycle)
    return true
  }
}

registerProcessor("pcm-player-processor", PCMPlayerProcessor)
