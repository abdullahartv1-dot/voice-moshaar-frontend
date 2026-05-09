/**
 * CallScreen — unified live-call experience with three modes:
 *
 *   1. **idle** — before the call:
 *      - Big orb pulsing softly in the centre
 *      - Tap the orb to start (no separate "Start" button)
 *      - Voice picker visible at the bottom
 *
 *   2. **active** — during the call:
 *      - Orb fills the screen, hue + rotation react to agent state
 *        (listening / thinking / speaking)
 *      - Pulse rings + waveform when listening (so the user feels
 *        heard; no more "did the mic catch me?" anxiety)
 *      - Bottom bar: Mute · Pause · End (red)
 *      - Top bar: elapsed time + selected voice + state label
 *      - Empty mid-section so the orb dominates
 *
 *   3. **review** — after End is pressed:
 *      - Switches to a chat-history view (user / assistant bubbles)
 *      - User bubbles include `<audio controls>` for the recorded turn
 *      - "بدء مكالمة جديدة" button at the top to come back to idle
 *
 * The component owns nothing related to networking. The parent
 * (`CallPage`) wires WebSocket, mic, transcripts, etc. We just render
 * its state and emit semantic events (onStartTap, onMuteToggle,
 * onPauseToggle, onEnd, onResume).
 */
import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  Pause,
  PhoneOff,
  Play,
  Sparkles,
  Volume2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { VoicePicker } from "@/components/ui/voice-picker"
import { VoicePoweredOrb, type OrbState } from "@/components/ui/voice-powered-orb"
import type { ConvState } from "@/api/conversation-ws"
import type { Voice } from "@/types/api"
import { cn } from "@/lib/utils"

export interface CallTurn {
  role: "user" | "assistant"
  text: string
  ts: number
  turn?: number
  audioUrl?: string
}

export interface CallScreenProps {
  // ---- mode ----
  /** "idle" before call, "active" while connected, "review" after end */
  mode: "idle" | "active" | "review"
  // ---- shared state for orb ----
  state: ConvState               // listening / thinking / speaking / idle
  micRms?: number                // 0-1, drives orb when listening
  // ---- meta ----
  voices: Voice[]
  selectedVoice: string
  onSelectedVoiceChange: (id: string | undefined) => void
  // ---- timing ----
  /** Unix-ms timestamp when the call started; used to render elapsed.
   *  Pass undefined when not in a call. */
  callStartedAt?: number
  stats?: { ttfa_ms: number; total_ms: number } | null
  error?: string | null
  // ---- pre-flight ----
  hasMic: boolean | null
  // ---- review-mode data ----
  turns: CallTurn[]
  isMuted: boolean
  isPaused: boolean
  // ---- callbacks ----
  /** User tapped the orb (in idle mode) — start the call. */
  onStartTap: () => void
  /** User tapped Mute — toggle mic on/off without ending the call. */
  onMuteToggle: () => void
  /** User tapped Pause — same as mute but flagged as pause. */
  onPauseToggle: () => void
  /** User tapped End — close everything and switch to review mode. */
  onEnd: () => void
  /** Review mode: user wants to start a fresh call. */
  onStartNew: () => void
}

const STATE_TO_ORB: Record<ConvState, OrbState> = {
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
}

const STATE_LABEL: Record<ConvState, string> = {
  idle: "ينتظر",
  listening: "يستمع",
  thinking: "يفكّر",
  speaking: "يتحدث",
}

const STATE_COLOR: Record<ConvState, string> = {
  idle: "text-muted-foreground",
  listening: "text-blue-400",
  thinking: "text-amber-400",
  speaking: "text-emerald-400",
}

export function CallScreen(props: CallScreenProps) {
  if (props.mode === "review") return <ReviewView {...props} />
  // idle + active share the orb layout, with subtle differences.
  return <OrbView {...props} />
}

// ---------------------------------------------------------------------------
// Orb view — shared by idle + active modes
// ---------------------------------------------------------------------------
function OrbView(props: CallScreenProps) {
  const {
    mode,
    state,
    micRms = 0,
    voices,
    selectedVoice,
    onSelectedVoiceChange,
    callStartedAt,
    stats,
    error,
    hasMic,
    isMuted,
    isPaused,
    onStartTap,
    onMuteToggle,
    onPauseToggle,
    onEnd,
  } = props
  const isActive = mode === "active"

  const elapsed = useElapsed(callStartedAt)
  const selectedName = voices.find((v) => v.voice_id === selectedVoice)?.name ?? selectedVoice

  return (
    <div
      className="-mx-4 -my-6 flex h-[calc(100svh-3.5rem)] flex-col items-center justify-between bg-gradient-to-b from-background via-background to-background/90 sm:-mx-6"
      dir="rtl"
    >
      {/* Top bar — voice info + elapsed */}
      <div className="z-10 flex w-full items-center justify-between px-6 pt-4">
        <motion.div
          className="text-xs text-muted-foreground"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {isActive ? (
            <span className="tabular-nums">{formatElapsed(elapsed)}</span>
          ) : (
            <span>جاهز للاتصال</span>
          )}
        </motion.div>

        <motion.div
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Sparkles className="size-3.5" />
          <span>الصوت: {selectedName}</span>
        </motion.div>
      </div>

      {/* Centre — the orb. Clickable when idle to start the call. */}
      <div className="relative flex flex-1 items-center justify-center">
        <motion.div
          className="relative"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          {/* Pulse rings — only while listening, gives "I hear you" feedback. */}
          <AnimatePresence>
            {isActive && state === "listening" && (
              <>
                <motion.div
                  key="ring-1"
                  className="pointer-events-none absolute inset-0 rounded-full border-2 border-blue-500/40"
                  initial={{ scale: 1, opacity: 0.7 }}
                  animate={{ scale: 1.6, opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
                />
                <motion.div
                  key="ring-2"
                  className="pointer-events-none absolute inset-0 rounded-full border border-blue-400/30"
                  initial={{ scale: 1, opacity: 0.5 }}
                  animate={{ scale: 2.2, opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut", delay: 0.4 }}
                />
              </>
            )}
          </AnimatePresence>

          {/* Orb — clickable when idle to start the call. */}
          <motion.button
            type="button"
            onClick={!isActive ? onStartTap : undefined}
            disabled={isActive || hasMic === false}
            className={cn(
              "relative size-64 overflow-hidden rounded-full sm:size-80",
              !isActive && "cursor-pointer transition-transform hover:scale-[1.03] active:scale-95",
              isActive && "cursor-default",
              hasMic === false && "cursor-not-allowed opacity-60",
            )}
            whileHover={!isActive && hasMic !== false ? { scale: 1.04 } : undefined}
            whileTap={!isActive && hasMic !== false ? { scale: 0.96 } : undefined}
            aria-label={isActive ? "أثناء المكالمة" : "اضغط لبدء المكالمة"}
          >
            <VoicePoweredOrb
              state={isActive ? STATE_TO_ORB[state] : "idle"}
              voiceLevel={isActive ? micRms : 0}
            />
            {/* Idle overlay — soft "tap to start" prompt */}
            <AnimatePresence>
              {!isActive && (
                <motion.div
                  className="pointer-events-none absolute inset-0 flex items-center justify-center"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0.55, 0.95, 0.55] }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                >
                  <span className="rounded-full bg-black/35 px-5 py-2 text-sm font-medium text-white backdrop-blur-sm">
                    اضغط لبدء المكالمة
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>
        </motion.div>

        {/* State label below the orb (only during active call) */}
        <AnimatePresence>
          {isActive && (
            <motion.div
              key={state}
              className="absolute bottom-[14%] flex items-center gap-2"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
            >
              {state === "thinking" && (
                <Loader2 className={cn("size-4 animate-spin", STATE_COLOR[state])} />
              )}
              <span className={cn("text-base font-medium", STATE_COLOR[state])}>
                {STATE_LABEL[state]}…
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Mic level meter — only while listening */}
      {isActive && (
        <div className="z-10 mb-4 flex h-12 items-end justify-center gap-1 px-4 sm:gap-1.5">
          <MicLevelBars rms={micRms} active={state === "listening" && !isMuted} />
        </div>
      )}

      {/* Errors / mic warnings */}
      {hasMic === false && !isActive && (
        <div className="mx-4 mb-3 flex max-w-md items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div>لا يوجد ميكروفون متصل بهذا الجهاز. افتح الصفحة من جوالك أو لابتوبك.</div>
        </div>
      )}
      {error && (
        <div className="mx-4 mb-3 flex max-w-md items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Bottom bar */}
      <div className="z-10 w-full pb-[max(env(safe-area-inset-bottom),1.25rem)] pt-3">
        {!isActive ? (
          // Idle: voice picker only — orb itself is the start button
          <div className="mx-auto max-w-md px-4">
            <VoicePicker
              voices={voices}
              value={selectedVoice}
              onValueChange={onSelectedVoiceChange}
            />
            {stats && (
              <p className="mt-3 text-center text-[11px] tabular-nums text-muted-foreground">
                آخر مكالمة: TTFA {stats.ttfa_ms} ms · إجمالي {stats.total_ms} ms
              </p>
            )}
          </div>
        ) : (
          // Active: Mute · Pause · End
          <div className="mx-auto flex max-w-md items-center justify-center gap-3 px-4">
            <CallControlButton
              onClick={onMuteToggle}
              icon={isMuted ? MicOff : Mic}
              label={isMuted ? "تشغيل" : "كتم"}
              tone={isMuted ? "warning" : "neutral"}
            />
            <CallControlButton
              onClick={onPauseToggle}
              icon={isPaused ? Play : Pause}
              label={isPaused ? "متابعة" : "إيقاف مؤقت"}
              tone={isPaused ? "warning" : "neutral"}
            />
            <CallControlButton
              onClick={onEnd}
              icon={PhoneOff}
              label="إنهاء"
              tone="danger"
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Review view — chat history after End is pressed
// ---------------------------------------------------------------------------
function ReviewView({
  turns,
  voices,
  selectedVoice,
  onSelectedVoiceChange,
  stats,
  onStartNew,
}: CallScreenProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const formatTime = (ts: number) =>
    new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit" }).format(new Date(ts))

  return (
    <div
      className="-mx-4 -my-6 flex h-[calc(100svh-3.5rem)] flex-col sm:-mx-6"
      dir="rtl"
    >
      {/* Header */}
      <div className="border-b border-border/60 bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">سجلّ المكالمة</h2>
            <p className="text-[11px] text-muted-foreground">
              {turns.length} {turns.length === 1 ? "رسالة" : "رسائل"}
              {stats && ` · TTFA ${stats.ttfa_ms} ms`}
            </p>
          </div>
          <Button onClick={onStartNew} size="sm">
            <Mic className="me-1.5 size-4" />
            مكالمة جديدة
          </Button>
        </div>
      </div>

      {/* Chat scroll area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 py-4">
          {turns.map((turn, i) => (
            <ChatBubble key={i} turn={turn} formatTime={formatTime} />
          ))}
          {turns.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              لم تُسجَّل أي رسائل في هذه المكالمة.
            </div>
          )}
          {turns.length > 0 && (
            <div className="flex justify-center pt-4">
              <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" />
                انتهت المكالمة
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Footer — voice picker for next call */}
      <div className="border-t border-border/60 bg-background/95 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 backdrop-blur sm:px-6">
        <div className="mx-auto max-w-md">
          <VoicePicker
            voices={voices}
            value={selectedVoice}
            onValueChange={onSelectedVoiceChange}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bits and pieces
// ---------------------------------------------------------------------------
function CallControlButton({
  onClick,
  icon: Icon,
  label,
  tone,
}: {
  onClick: () => void
  icon: React.ElementType
  label: string
  tone: "neutral" | "warning" | "danger"
}) {
  const styles = {
    neutral: "bg-card hover:bg-card/80 border border-border text-foreground",
    warning: "bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-700 dark:text-amber-300",
    danger:  "bg-destructive hover:bg-destructive/90 border border-destructive text-destructive-foreground",
  }[tone]
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.92 }}
      className={cn(
        "flex h-14 min-w-[88px] flex-1 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium shadow-sm transition-colors",
        styles,
      )}
    >
      <Icon className="size-5" />
      <span>{label}</span>
    </motion.button>
  )
}

/**
 * 24-bar mic level indicator. Each bar is animated independently with
 * a height proportional to a smoothed RMS plus a small per-bar offset
 * so it doesn't look like a flat block. When `active=false`, all bars
 * collapse to a baseline.
 */
function MicLevelBars({ rms, active }: { rms: number; active: boolean }) {
  // Smooth the rms a bit so the bars don't look jittery — the worklet
  // posts ~15 fps; the RAF ticks 60 fps, so a soft trail looks better.
  const [smooth, setSmooth] = React.useState(0)
  React.useEffect(() => {
    let raf = 0
    let cur = 0
    const tick = () => {
      cur += (rms - cur) * 0.18
      setSmooth(cur)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [rms])

  const N = 24
  return (
    <>
      {Array.from({ length: N }).map((_, i) => {
        // Symmetric bell curve — middle bars taller than the edges,
        // makes the cluster look like a "voice equaliser" rather than a
        // flat strip.
        const distFromCentre = Math.abs(i - (N - 1) / 2) / ((N - 1) / 2)
        const env = 1 - 0.65 * distFromCentre
        const target = active ? Math.max(0.06, smooth) * env : 0.06
        // Per-bar phase so adjacent bars don't all wobble in unison.
        const wobble = active ? Math.sin(Date.now() * 0.01 + i * 0.7) * 0.07 : 0
        const heightPct = Math.min(1, Math.max(0.06, target + wobble))
        return (
          <motion.span
            key={i}
            className={cn(
              "block w-1 rounded-full sm:w-1.5",
              active
                ? "bg-blue-400/85 dark:bg-blue-300/90"
                : "bg-muted-foreground/30",
            )}
            animate={{ height: `${heightPct * 100}%` }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            style={{ minHeight: 4 }}
          />
        )
      })}
    </>
  )
}

function ChatBubble({
  turn,
  formatTime,
}: {
  turn: CallTurn
  formatTime: (ts: number) => string
}) {
  const isUser = turn.role === "user"
  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm sm:max-w-[75%]",
          isUser
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm border bg-card",
        )}
      >
        {isUser && turn.audioUrl && (
          <audio
            controls
            preload="metadata"
            src={turn.audioUrl}
            className="w-full max-w-xs rounded-lg"
            style={{ accentColor: "currentColor" }}
          />
        )}
        <span dir="auto">{turn.text || (isUser ? "…" : "")}</span>
      </div>
      <span className="mt-1 px-1 text-[10px] text-muted-foreground">
        {isUser ? (
          <span className="inline-flex items-center gap-1">
            <Mic className="size-3" />
            أنت
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Volume2 className="size-3" />
            المساعد
          </span>
        )}{" "}
        · {formatTime(turn.ts)}
      </span>
    </div>
  )
}

function useElapsed(startedAt: number | undefined) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!startedAt) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [startedAt])
  if (!startedAt) return 0
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
}
