/**
 * ChatCallView — the new default voice-agent UI.
 *
 * A WhatsApp/Telegram-style chat layout where the user can freely switch
 * between three input modes without ending the session:
 *
 *   • Type a text message
 *   • Press-and-hold the mic for a voice note
 *   • Tap the broadcast button to enter continuous live-call mode
 *
 * The waveform sits just above the input bar (per user request) and
 * reflects whatever is happening: idle / listening (mic RMS) /
 * thinking / speaking (synthesised envelope).
 *
 * This component owns NO networking — the parent <CallPage /> wires the
 * WebSocket + mic and feeds turns through `turns` + state callbacks.
 *
 * Haptic feedback (when supported):
 *   - light tap when a record / live button is pressed
 *   - single buzz when a message leaves the device
 *   - double tap when the AI finishes responding
 */
import * as React from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  AlertCircle,
  CheckCircle2,
  Mic,
  Sparkles,
  Volume2,
} from "lucide-react"

import { VoicePicker } from "@/components/ui/voice-picker"
import { ChatInputBar, type RecordingState } from "@/components/ui/chat-input-bar"
import { ChatWaveform, type WaveformState } from "@/components/ui/chat-waveform"
import type { ConvState } from "@/api/conversation-ws"
import type { Voice } from "@/types/api"
import { cn } from "@/lib/utils"

export interface ChatCallTurn {
  role: "user" | "assistant"
  text: string
  ts: number
  turn?: number
  audioUrl?: string
}

export interface ChatCallViewProps {
  // ── shared state ──
  state: ConvState
  micRms?: number

  // ── transcript history ──
  turns: ChatCallTurn[]

  // ── voice picker (top-right popover) ──
  voices: Voice[]
  selectedVoice: string
  onSelectedVoiceChange: (id: string | undefined) => void

  // ── pre-flight / errors ──
  hasMic: boolean | null
  error?: string | null

  // ── input bar state ──
  liveCallActive: boolean
  recordingState: RecordingState
  disabled?: boolean

  // ── input bar callbacks ──
  onSendText: (content: string) => void
  onVoiceNoteStart: () => void
  onVoiceNoteStop: (cancelled: boolean) => void
  onLiveCallToggle: () => void

  // ── stats (last completed turn) ──
  stats?: { ttfa_ms: number; total_ms: number } | null

  // ── header / connection chip ──
  llmBackendBadge?: string  // "gemma" | "openai" — shown in the header
  mcpConnected?: boolean
}

const STATE_TO_WAVE: Record<ConvState, WaveformState> = {
  idle: "idle",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
}

const STATE_LABEL_AR: Record<ConvState, string> = {
  idle: "جاهز",
  listening: "يستمع",
  thinking: "يفكّر",
  speaking: "يردّ",
}

export function ChatCallView({
  state,
  micRms = 0,
  turns,
  voices,
  selectedVoice,
  onSelectedVoiceChange,
  hasMic,
  error,
  liveCallActive,
  recordingState,
  disabled,
  onSendText,
  onVoiceNoteStart,
  onVoiceNoteStop,
  onLiveCallToggle,
  stats,
  llmBackendBadge,
  mcpConnected,
}: ChatCallViewProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  // Auto-scroll to bottom on new turns
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Only autoscroll if user is already near the bottom — don't yank
    // them away from history they're reading.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    }
  }, [turns.length])

  // Waveform state — when live, reflect ConvState; when recording a
  // voice note, force "listening"; otherwise idle.
  const waveState: WaveformState =
    recordingState === "recording"
      ? "listening"
      : liveCallActive
        ? STATE_TO_WAVE[state]
        : state === "thinking" || state === "speaking"
          ? STATE_TO_WAVE[state]
          : "idle"

  const selectedName =
    voices.find((v) => v.voice_id === selectedVoice)?.name ?? selectedVoice

  return (
    <div
      className="-mx-4 -my-6 flex h-[calc(100svh-3.5rem)] flex-col sm:-mx-6"
      dir="rtl"
    >
      {/* ── Header ── */}
      <div className="border-b border-border/60 bg-background/95 px-3 py-2 backdrop-blur sm:px-5">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="size-9 shrink-0 rounded-full bg-gradient-to-br from-emerald-400 to-blue-500 flex items-center justify-center">
              <Sparkles className="size-4 text-white" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">سارة — مساعدة مستشار</div>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn(
                  "size-1.5 rounded-full",
                  liveCallActive ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/50",
                )} />
                {liveCallActive ? `بث مباشر · ${STATE_LABEL_AR[state]}` : STATE_LABEL_AR[state]}
                {mcpConnected && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">مستشار</span>}
                {llmBackendBadge && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{llmBackendBadge}</span>}
              </div>
            </div>
          </div>

          <VoicePicker
            voices={voices}
            value={selectedVoice}
            onValueChange={onSelectedVoiceChange}
          />
        </div>
      </div>

      {/* ── Chat history (scrollable) ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-muted/20 px-3 sm:px-5">
        <div className="mx-auto flex max-w-3xl flex-col gap-2.5 py-4">
          {turns.length === 0 && (
            <EmptyState
              liveCallActive={liveCallActive}
              hasMic={hasMic ?? true}
            />
          )}
          {turns.map((turn, i) => (
            <ChatBubble key={i} turn={turn} />
          ))}
          {stats && turns.length > 0 && (
            <div className="flex justify-center pt-2">
              <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                <CheckCircle2 className="size-3" />
                TTFA {stats.ttfa_ms} ms · إجمالي {stats.total_ms} ms
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Errors / mic warnings ── */}
      {(error || hasMic === false) && (
        <div className="border-t border-border/60 bg-background/95 px-3 py-2 sm:px-5">
          <div className="mx-auto max-w-3xl">
            {hasMic === false && (
              <div className="mb-1.5 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <span>لا يوجد ميكروفون متصل — وضع النص فقط متاح.</span>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Waveform (always above the input bar) ── */}
      <div className="border-t border-border/60 bg-background/95 pt-2">
        <ChatWaveform state={waveState} micRms={micRms} />
      </div>

      {/* ── Input bar (3-mode) ── */}
      <ChatInputBar
        liveCallActive={liveCallActive}
        recordingState={recordingState}
        disabled={disabled}
        onSendText={onSendText}
        onVoiceNoteStart={onVoiceNoteStart}
        onVoiceNoteStop={onVoiceNoteStop}
        onLiveCallToggle={onLiveCallToggle}
      />
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// Subcomponents
// ──────────────────────────────────────────────────────────────────────

function EmptyState({
  liveCallActive,
  hasMic,
}: {
  liveCallActive: boolean
  hasMic: boolean
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center"
    >
      <div className="size-16 rounded-full bg-gradient-to-br from-emerald-400/20 to-blue-500/20 flex items-center justify-center">
        <Sparkles className="size-6 text-emerald-500" />
      </div>
      <h3 className="text-base font-semibold">ابدا التحدث</h3>
      <p className="text-sm text-muted-foreground">
        {liveCallActive
          ? "البث المباشر شغّال — تكلّم الآن وسأستمع"
          : hasMic
            ? "اكتب، أو اضغط مطوّلاً على 🎙️ لتسجيل صوت، أو اضغط 📞 لبدء بث مباشر."
            : "اكتب رسالة لتبدأ المحادثة. الميكروفون غير متاح على هذا الجهاز."}
      </p>
    </motion.div>
  )
}

function ChatBubble({ turn }: { turn: ChatCallTurn }) {
  const isUser = turn.role === "user"
  const hasAudio = isUser && !!turn.audioUrl
  const time = new Intl.DateTimeFormat("ar", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(turn.ts))

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.18 }}
      className={cn("flex flex-col", isUser ? "items-end" : "items-start")}
    >
      <div
        className={cn(
          "flex flex-col gap-1.5 rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm",
          hasAudio
            ? "min-w-[260px] max-w-[400px] sm:min-w-[300px]"
            : "max-w-[88%] sm:max-w-[75%]",
          isUser
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm border bg-background",
        )}
      >
        {isUser && turn.audioUrl && (
          <audio
            controls
            preload="metadata"
            src={turn.audioUrl}
            className="w-full min-w-[240px] max-w-[360px] rounded-md"
            style={{ accentColor: "currentColor" }}
          />
        )}
        <span dir="auto">{turn.text || (isUser ? "…" : "")}</span>
      </div>
      <span className="mt-0.5 px-1 text-[10px] text-muted-foreground">
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
        · {time}
      </span>
    </motion.div>
  )
}
