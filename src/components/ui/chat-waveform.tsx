/**
 * Chat-waveform — slim, always-visible audio level indicator that sits
 * just above the message input bar. Replaces the old standalone mic
 * level meter so the user gets continuous feedback regardless of which
 * mode they're in (text / voice-note / live-call).
 *
 * Three visual states:
 *   - idle:      flat baseline of muted bars (subtle "ready" hint)
 *   - listening: bars rise with the live mic RMS (user is talking)
 *   - speaking:  bars wobble with a generated envelope (AI is talking;
 *                we don't know the audio amplitude before it's played,
 *                so we synthesize one that looks natural)
 */
import * as React from "react"
import { motion } from "framer-motion"
import { cn } from "@/lib/utils"

export type WaveformState = "idle" | "listening" | "thinking" | "speaking"

export interface ChatWaveformProps {
  /** Current logical state — drives bar colour + behaviour. */
  state: WaveformState
  /** Live mic RMS in [0, ~1]. Used in listening mode. */
  micRms?: number
  /** Number of bars. Defaults to 28 — looks good 320-480px wide. */
  bars?: number
  className?: string
}

export function ChatWaveform({
  state,
  micRms = 0,
  bars = 28,
  className,
}: ChatWaveformProps) {
  // Smooth incoming RMS so bars don't jitter at 60 fps when the worklet
  // posts at 15 fps. A simple low-pass with α=0.18 matches the existing
  // MicLevelBars look.
  const [smooth, setSmooth] = React.useState(0)
  const phaseRef = React.useRef(0)
  const [, force] = React.useReducer((n: number) => n + 1, 0)

  React.useEffect(() => {
    let raf = 0
    let cur = 0
    const tick = () => {
      cur += (micRms - cur) * 0.18
      setSmooth(cur)
      phaseRef.current += 0.07
      // Force re-render every frame in active states so the bars
      // animate even when micRms doesn't change (e.g. speaking mode
      // where we generate the envelope ourselves).
      if (state === "speaking" || state === "thinking") force()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [micRms, state])

  const colourClass = {
    idle: "bg-muted-foreground/25",
    listening: "bg-blue-400/85 dark:bg-blue-300/90",
    thinking: "bg-amber-400/80",
    speaking: "bg-emerald-400/85",
  }[state]

  return (
    <div
      className={cn(
        "pointer-events-none flex h-8 items-end justify-center gap-[3px] px-3",
        className,
      )}
      aria-hidden
    >
      {Array.from({ length: bars }).map((_, i) => {
        // Bell-curve envelope so the middle is taller than the edges.
        const distFromCentre = Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2)
        const env = 1 - 0.55 * distFromCentre

        let target = 0.12 // baseline
        if (state === "listening") {
          target = Math.max(0.12, smooth * 1.8) * env
        } else if (state === "speaking") {
          // Synthesized envelope: two sines with a per-bar phase so
          // adjacent bars wobble out of sync.
          const t = phaseRef.current + i * 0.4
          const wobble = (Math.sin(t) + Math.sin(t * 0.6 + 0.3) * 0.5) * 0.5
          target = (0.4 + 0.35 * wobble) * env
        } else if (state === "thinking") {
          // Soft pulsing for "thinking"
          const t = phaseRef.current + i * 0.25
          target = (0.18 + 0.08 * Math.sin(t)) * env
        }

        const height = Math.max(0.1, Math.min(1, target))
        return (
          <motion.span
            key={i}
            className={cn("block w-[3px] rounded-full sm:w-1", colourClass)}
            animate={{ height: `${height * 100}%` }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            style={{ minHeight: 3 }}
          />
        )
      })}
    </div>
  )
}
