/**
 * LiveCallOverlay — prominent visual indicator that sits at the top of
 * the chat when a live call is active. Per the design brief:
 *
 *   "عند الضغط [على البث المباشر] يجب أن تظهر في المقدمة أيقونة التفاعل
 *    لكي يرى المستخدم تجاوب المكالمة"
 *
 * Shows a large pulsing orb whose appearance reacts to the agent state:
 *   listening  → soft blue pulse + concentric rings
 *   thinking   → amber slow spin
 *   speaking   → emerald breathing scale + radial bars
 *
 * Above the chat history (so the user can still see the conversation
 * thread below). Tapping the orb is a no-op; the user ends the call
 * via the broadcast button in the input bar (which morphs into "exit"
 * while active).
 */
import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Loader2, Mic, Sparkles, Volume2 } from "lucide-react"

import type { ConvState } from "@/api/conversation-ws"
import { cn } from "@/lib/utils"

export interface LiveCallOverlayProps {
  state: ConvState
  micRms?: number
}

const STATE_TO_LABEL: Record<ConvState, string> = {
  idle: "ينتظر",
  listening: "يستمع",
  thinking: "يفكّر",
  speaking: "يتحدث",
}

const STATE_TO_TONE: Record<ConvState, string> = {
  idle: "from-slate-400/70 to-slate-600/70",
  listening: "from-blue-400 to-blue-600",
  thinking: "from-amber-300 to-amber-500",
  speaking: "from-emerald-400 to-emerald-600",
}

export function LiveCallOverlay({ state, micRms = 0 }: LiveCallOverlayProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -16 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="relative flex flex-col items-center justify-center py-6"
      dir="rtl"
    >
      {/* Concentric pulse rings — only while listening */}
      <AnimatePresence>
        {state === "listening" && (
          <>
            <motion.div
              key="r1"
              className="pointer-events-none absolute size-36 rounded-full border-2 border-blue-500/40"
              initial={{ scale: 1, opacity: 0.7 }}
              animate={{ scale: 1.7, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
            />
            <motion.div
              key="r2"
              className="pointer-events-none absolute size-36 rounded-full border border-blue-400/30"
              initial={{ scale: 1, opacity: 0.5 }}
              animate={{ scale: 2.3, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: 1.6, repeat: Infinity, ease: "easeOut", delay: 0.4,
              }}
            />
          </>
        )}
      </AnimatePresence>

      {/* The orb itself */}
      <motion.div
        className={cn(
          "relative flex size-36 items-center justify-center rounded-full",
          "shadow-2xl",
          "bg-gradient-to-br",
          STATE_TO_TONE[state],
        )}
        animate={
          state === "speaking"
            ? { scale: [1, 1.05 + micRms * 0.1, 1] }
            : state === "listening"
              ? { scale: 1 + micRms * 0.2 }
              : { scale: 1 }
        }
        transition={
          state === "speaking"
            ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
            : { duration: 0.3, ease: "easeOut" }
        }
      >
        {/* Inner halo */}
        <div className="absolute inset-2 rounded-full bg-white/15 backdrop-blur-sm" />
        {/* Center icon */}
        <div className="relative z-10 flex flex-col items-center gap-0.5 text-white">
          {state === "listening" && <Mic className="size-8" />}
          {state === "thinking" && <Loader2 className="size-8 animate-spin" />}
          {state === "speaking" && <Volume2 className="size-8" />}
          {state === "idle" && <Sparkles className="size-8" />}
        </div>
      </motion.div>

      {/* State label */}
      <AnimatePresence mode="wait">
        <motion.div
          key={state}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className="mt-4 text-sm font-medium text-foreground"
        >
          {STATE_TO_LABEL[state]}…
        </motion.div>
      </AnimatePresence>

      {/* Helper line */}
      <div className="mt-1 text-[11px] text-muted-foreground">
        البث المباشر — تكلّم بطبيعية
      </div>
    </motion.div>
  )
}
