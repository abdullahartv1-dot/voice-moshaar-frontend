import * as React from "react"
import { cn } from "@/lib/utils"

export type OrbState = "idle" | "thinking" | "talking"

interface OrbProps extends React.HTMLAttributes<HTMLDivElement> {
  agentState?: OrbState
}

/**
 * Animated voice indicator. Pure CSS — no GPU shaders, plays nicely on mobile.
 *
 * - idle: subtle gradient, faint ring
 * - thinking: rotating conic gradient
 * - talking: rotating + pulsing + hue-shift
 */
export const Orb = React.forwardRef<HTMLDivElement, OrbProps>(
  ({ agentState = "idle", className, ...props }, ref) => {
    const animations = (() => {
      switch (agentState) {
        case "talking":
          return "orb-spin 4s linear infinite, orb-pulse 1.4s ease-in-out infinite, orb-talking 1.6s ease-in-out infinite"
        case "thinking":
          return "orb-spin 8s linear infinite"
        default:
          return undefined
      }
    })()

    return (
      <div
        ref={ref}
        className={cn(
          "relative aspect-square overflow-visible rounded-full",
          "bg-[radial-gradient(circle_at_30%_30%,oklch(0.85_0.18_305),oklch(0.55_0.22_305)_55%,oklch(0.32_0.15_305)_100%)]",
          "shadow-[inset_-2px_-2px_4px_rgba(0,0,0,0.18),inset_2px_2px_4px_rgba(255,255,255,0.18)]",
          "ring-1 ring-primary/40",
          className
        )}
        style={{ animation: animations }}
        {...props}
      >
        <div
          className={cn(
            "absolute inset-[15%] rounded-full opacity-60",
            "bg-[conic-gradient(from_120deg,transparent,oklch(0.95_0.1_305),transparent_60%)]"
          )}
          style={
            agentState === "idle"
              ? undefined
              : { animation: "orb-spin 3s linear infinite reverse" }
          }
        />
      </div>
    )
  }
)
Orb.displayName = "Orb"
