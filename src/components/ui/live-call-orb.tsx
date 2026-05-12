/**
 * LiveCallOrb — small floating "I'm in live mode" indicator.
 *
 * Sits just above the message input bar so it never blocks the chat,
 * matching the ChatGPT-style voice-mode pattern. The chat history
 * stays scrollable and visible behind it while the call is active.
 *
 * State → visual:
 *   listening  → blue pulse, subtle scale w/ mic RMS
 *   thinking   → amber slow rotation
 *   speaking   → emerald breathing scale
 *   idle       → faint slate
 *
 * Size is intentionally small (~80 px) so even on tight screens you
 * still see the last few messages of the conversation.
 */
import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"

import type { ConvState } from "@/api/conversation-ws"
import { cn } from "@/lib/utils"

export interface LiveCallOrbProps {
  state: ConvState
  micRms?: number
  size?: number  // pixel size, default 80
}

export function LiveCallOrb({ state, micRms = 0, size = 80 }: LiveCallOrbProps) {
  const tone = {
    idle: "from-slate-300/70 via-slate-400 to-slate-500",
    listening: "from-blue-300 via-blue-400 to-blue-600",
    thinking: "from-amber-200 via-amber-400 to-amber-600",
    speaking: "from-emerald-300 via-emerald-400 to-emerald-600",
  }[state]

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="pointer-events-none relative flex items-center justify-center py-2"
    >
      {/* Single soft pulse ring while listening — much smaller than
          the old big-orb design so it doesn't reach the chat history. */}
      <AnimatePresence>
        {state === "listening" && (
          <motion.div
            key="pulse"
            className="absolute rounded-full border-2 border-blue-400/50"
            style={{ width: size, height: size }}
            initial={{ scale: 1, opacity: 0.65 }}
            animate={{ scale: 1.4, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

      {/* The orb */}
      <motion.div
        className={cn(
          "rounded-full bg-gradient-to-br shadow-lg",
          tone,
        )}
        style={{ width: size, height: size }}
        animate={
          state === "speaking"
            ? { scale: [1, 1.06, 1] }
            : state === "listening"
              ? { scale: 1 + Math.min(0.18, micRms * 1.5) }
              : state === "thinking"
                ? { rotate: 360 }
                : { scale: 1 }
        }
        transition={
          state === "speaking"
            ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
            : state === "thinking"
              ? { duration: 3, repeat: Infinity, ease: "linear" }
              : { duration: 0.25, ease: "easeOut" }
        }
      >
        {/* Inner highlight (gives the 3D feel like ChatGPT's orb) */}
        <div className="absolute inset-[12%] rounded-full bg-white/25 blur-sm" />
        <div className="absolute inset-[28%] rounded-full bg-white/20" />
      </motion.div>
    </motion.div>
  )
}
