/**
 * ChatInputBar — bottom bar with three input modes:
 *
 *   1. Text — type and send (or Enter to send)
 *   2. Voice note — press and hold the mic button to record; release to send
 *   3. Live call — tap the broadcast button to open a continuous WS stream;
 *      the button turns into "Exit" while live mode is active
 *
 * The bar doesn't own any networking — it emits semantic events:
 *   - onSendText(content)
 *   - onVoiceNoteStart / onVoiceNoteStop  (parent runs the mic + WS)
 *   - onLiveCallToggle  (parent flips between live-call and idle)
 */
import * as React from "react"
import { motion } from "framer-motion"
import {
  Loader2,
  Mic,
  Phone,
  PhoneOff,
  Send,
} from "lucide-react"
import { cn } from "@/lib/utils"

export type RecordingState = "idle" | "recording" | "sending"

export interface ChatInputBarProps {
  /** True when a live call is currently active. Flips the broadcast
   *  button to "Exit". */
  liveCallActive: boolean
  /** Voice-note recording state (parent-owned because it controls the mic). */
  recordingState: RecordingState
  /** Disables ALL inputs (e.g. while connecting, or no mic permission). */
  disabled?: boolean

  onSendText: (content: string) => void
  /** Voice-note: parent handles mic + creating the WS turn. */
  onVoiceNoteStart: () => void
  onVoiceNoteStop: (cancelled: boolean) => void
  /** Live call: parent toggles continuous streaming. */
  onLiveCallToggle: () => void

  /** Optional: text shown in the input placeholder. */
  placeholder?: string
}

export function ChatInputBar({
  liveCallActive,
  recordingState,
  disabled = false,
  onSendText,
  onVoiceNoteStart,
  onVoiceNoteStop,
  onLiveCallToggle,
  placeholder = "اكتب رسالتك...",
}: ChatInputBarProps) {
  const [text, setText] = React.useState("")
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)

  // Send-on-Enter (Shift+Enter = newline). Empty input → no-op.
  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const submit = () => {
    const v = text.trim()
    if (!v || disabled) return
    onSendText(v)
    setText("")
  }

  const isRecording = recordingState === "recording"
  const isSending = recordingState === "sending"

  // Press-and-hold pattern for voice note. Two handlers: pointerdown (begin)
  // and pointerup / pointerleave / pointercancel (commit/cancel).
  const recordRef = React.useRef<{ committed: boolean }>({ committed: false })
  const handleRecordStart = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || liveCallActive) return
    e.preventDefault()
    recordRef.current.committed = true
    onVoiceNoteStart()
  }
  const handleRecordEnd = (cancelled = false) => {
    if (!recordRef.current.committed) return
    recordRef.current.committed = false
    onVoiceNoteStop(cancelled)
  }

  return (
    <div
      className={cn(
        "border-t border-border/60 bg-background/95 backdrop-blur",
        "px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 sm:px-4",
      )}
      dir="rtl"
    >
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        {/* Text input */}
        <div className="relative flex-1">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKey}
            placeholder={
              liveCallActive
                ? "البث المباشر شغّال — اضغط أيقونة الخروج لإيقافه"
                : isRecording
                  ? "ابدأ التحدث — حرّر الزر للإرسال"
                  : placeholder
            }
            disabled={disabled || liveCallActive || isRecording}
            rows={1}
            className={cn(
              "block w-full resize-none rounded-2xl border border-input bg-background px-4 py-2.5 text-sm",
              "placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none",
              "min-h-[44px] max-h-[140px]",
              (disabled || liveCallActive || isRecording) && "opacity-60",
            )}
            style={{
              // Approximate auto-grow without a layout effect
              height: Math.min(140, 44 + (text.split("\n").length - 1) * 22),
            }}
            dir="auto"
          />
        </div>

        {/* Send button (only enabled when there's text) */}
        {text.trim().length > 0 && !liveCallActive && !isRecording && (
          <motion.button
            type="button"
            onClick={submit}
            disabled={disabled}
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            whileTap={{ scale: 0.92 }}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full",
              "bg-primary text-primary-foreground shadow-sm",
              "hover:bg-primary/90 disabled:opacity-50",
            )}
            aria-label="إرسال"
          >
            <Send className="size-5 -rotate-180" />
          </motion.button>
        )}

        {/* Voice-note record button (only when no text) */}
        {text.trim().length === 0 && (
          <motion.button
            type="button"
            disabled={disabled || liveCallActive || isSending}
            onPointerDown={handleRecordStart}
            onPointerUp={() => handleRecordEnd(false)}
            onPointerLeave={() => handleRecordEnd(false)}
            onPointerCancel={() => handleRecordEnd(true)}
            whileTap={{ scale: 0.95 }}
            animate={isRecording ? { scale: [1, 1.08, 1] } : { scale: 1 }}
            transition={
              isRecording
                ? { duration: 1.0, repeat: Infinity, ease: "easeInOut" }
                : { duration: 0.2 }
            }
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-full",
              "border border-border bg-card text-foreground shadow-sm",
              "hover:bg-accent",
              isRecording && "border-red-500/70 bg-red-500/15 text-red-600",
              (disabled || liveCallActive) && "opacity-40",
            )}
            aria-label={isRecording ? "أرسل التسجيل (حرّر)" : "اضغط مطوّلاً للتسجيل"}
          >
            {isSending ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <Mic className="size-5" />
            )}
          </motion.button>
        )}

        {/* Live broadcast button — morphs to "Exit" when active */}
        <motion.button
          type="button"
          onClick={onLiveCallToggle}
          disabled={disabled || isRecording}
          whileTap={{ scale: 0.95 }}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full shadow-sm transition-colors",
            liveCallActive
              ? "bg-red-500 text-white hover:bg-red-600"
              : "border border-border bg-card text-foreground hover:bg-accent",
            (disabled || isRecording) && "opacity-40",
          )}
          aria-label={liveCallActive ? "إنهاء البث المباشر" : "بدء بث مباشر"}
          title={liveCallActive ? "إنهاء البث" : "بث مباشر"}
        >
          {liveCallActive ? (
            <PhoneOff className="size-5" />
          ) : (
            <Phone className="size-5" />
          )}
        </motion.button>
      </div>

      {/* Hint text under the bar */}
      <div className="mx-auto mt-1.5 max-w-3xl text-center text-[10px] text-muted-foreground/70">
        {liveCallActive ? (
          <span>أنت في بث مباشر — تكلّم بشكل طبيعي والمساعد يستمع باستمرار</span>
        ) : isRecording ? (
          <span>اتركه عند الانتهاء، أو اسحب بعيداً للإلغاء</span>
        ) : (
          <span>اكتب / اضغط 🎙️ للتسجيل / اضغط 📞 لبدء بث مباشر</span>
        )}
      </div>
    </div>
  )
}
