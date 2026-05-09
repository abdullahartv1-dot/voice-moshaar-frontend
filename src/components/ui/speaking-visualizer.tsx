/**
 * SpeakingVisualizer — radial audio bars + heartbeat pulse halo around
 * the orb, shown only while the agent is speaking.
 *
 * Two visual layers, both turn on together when `active=true`:
 *
 *   1. **Radial bars.** 48 thin bars arranged around a circle just
 *      outside the orb's edge. Each bar's height oscillates with a
 *      phase-shifted sine wave + a slight Perlin-style jitter, giving
 *      the look of an audio frequency spectrum visualised circularly.
 *      The user instantly reads "audio is playing" from this without
 *      any text label.
 *
 *   2. **Heartbeat halo.** A faint outer glow that breathes 1.0 → 1.06
 *      → 1.0 in a slow rhythm, so the orb itself looks like it's
 *      "alive" while talking.
 *
 * We synthesise the waveform rather than analysing the actual TTS
 * stream because (a) the existing PCM player worklet doesn't expose a
 * meter, and (b) the visual effect we want — a steady, rhythmic
 * "speaking pulse" — is exactly what a synthetic curve produces; real
 * audio levels would jitter unpredictably during pauses between words.
 *
 * `active=false` collapses both layers gracefully via opacity transitions
 * so toggling on/off doesn't visibly pop.
 */
import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"

import { cn } from "@/lib/utils"

export interface SpeakingVisualizerProps {
  /** Show the bars + halo. Pass false in idle/listening/thinking. */
  active: boolean
  /** Tailwind class for bar colour (default emerald to match speaking
   *  state's hue). Override if you want to tint per voice or theme. */
  barClassName?: string
  className?: string
}

const BAR_COUNT = 48        // even number → symmetric layout
// Each bar has its own oscillator phase so adjacent bars don't pulse
// in unison (looks like a flat ring otherwise). Pre-computed to avoid
// allocating arrays on every animation frame.
const BAR_PHASES = Array.from({ length: BAR_COUNT }, (_, i) => i * 0.41)
const BAR_FREQS = Array.from({ length: BAR_COUNT }, (_, i) =>
  // Three slightly-different frequency layers blend into a wave-like
  // pattern that doesn't repeat too obviously.
  1.6 + (i % 5) * 0.13 + (i % 3) * 0.07,
)

export function SpeakingVisualizer({
  active,
  barClassName,
  className,
}: SpeakingVisualizerProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  // Bar refs let us mutate `style.height` directly per frame instead
  // of going through React state — at 60 fps × 48 bars that would
  // blow the reconciler. setProperty is what makes this cheap.
  const barRefs = React.useRef<Array<HTMLSpanElement | null>>([])
  // Radius in CSS px — used to push each bar outward to the orb's edge.
  // Measured from the container's actual rendered width on mount and
  // re-measured on resize so the bars sit on the circle at every
  // breakpoint (size-64 mobile = 128 px radius, sm:size-80 = 160 px).
  const [radius, setRadius] = React.useState(128)
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0) setRadius(rect.width / 2)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  React.useEffect(() => {
    if (!active) {
      // Reset to baseline so the next activation starts from a clean
      // state instead of the last frame before deactivation.
      for (const el of barRefs.current) {
        if (el) el.style.height = "6px"
      }
      return
    }
    let raf = 0
    const start = performance.now()
    const tick = () => {
      const t = (performance.now() - start) * 0.004 // ~ rad/sec
      for (let i = 0; i < BAR_COUNT; i++) {
        const el = barRefs.current[i]
        if (!el) continue
        // Two-layer sine for richer motion + small bias so a bar is
        // never exactly zero (looks dead otherwise).
        const a = Math.sin(t * BAR_FREQS[i] + BAR_PHASES[i])
        const b = Math.sin(t * BAR_FREQS[i] * 0.5 + BAR_PHASES[i] * 1.7)
        const wave = 0.55 + 0.35 * a + 0.20 * b
        // Map [0,1.1] → [6px, 26px]. Saturate at 26 so clipped peaks
        // don't make bars erratic.
        const px = Math.max(6, Math.min(26, 6 + wave * 22))
        el.style.height = `${px}px`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])

  return (
    <div
      ref={containerRef}
      className={cn(
        "pointer-events-none absolute inset-0",
        "transition-opacity duration-300",
        active ? "opacity-100" : "opacity-0",
        className,
      )}
      aria-hidden="true"
    >
      {/* Heartbeat halo — gentle outer glow that scales on the speaking
         rhythm. Sits behind the bars in z-order. */}
      <AnimatePresence>
        {active && (
          <motion.div
            className="absolute inset-[-12%] rounded-full bg-emerald-400/15 blur-2xl"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{
              opacity: [0.35, 0.65, 0.35],
              scale: [1.0, 1.06, 1.0],
            }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{
              duration: 1.4,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        )}
      </AnimatePresence>

      {/* Radial bars positioned around the orb's edge.
         Transform reads right-to-left:
            1. translateY(-radius)  → push bar UP by `radius` from centre
            2. rotate(angle)        → rotate around the original centre
            3. translate(-50%,-50%) → centre the bar on the rotation axis
         End result: 48 bars spread evenly around a circle of radius
         `radius` px, each pointing radially outward from the centre. */}
      {Array.from({ length: BAR_COUNT }).map((_, i) => {
        const angle = (i / BAR_COUNT) * 360
        return (
          <span
            key={i}
            ref={(el) => { barRefs.current[i] = el }}
            className={cn(
              "absolute left-1/2 top-1/2 w-[3px] rounded-full will-change-[height]",
              "bg-emerald-400/90 shadow-[0_0_6px_rgba(16,185,129,0.6)]",
              barClassName,
            )}
            style={{
              height: "6px",
              transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-${radius}px)`,
              transformOrigin: "center",
            }}
          />
        )
      })}
    </div>
  )
}
