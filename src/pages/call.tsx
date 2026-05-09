import * as React from "react"
import { useAtom } from "jotai"
import { useTranslation } from "react-i18next"
import {
  AlertCircle,
  Mic,
  MicOff,
  PhoneOff,
  RotateCcw,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Orb } from "@/components/ui/orb"
import { VoicePicker } from "@/components/ui/voice-picker"
import { useVoices } from "@/api/hooks"
import { ConversationClient, type ConvState } from "@/api/conversation-ws"
import { useMicCapture } from "@/hooks/useMicCapture"
import { selectedVoiceAtom } from "@/store/atoms"
import { BACKEND_URL, API_KEY } from "@/api/client"
import { cn } from "@/lib/utils"

interface Turn {
  role: "user" | "assistant"
  text: string
  ts: number
  /** For user turns: server-side turn idx (lets a `late` transcript find this row) */
  turn?: number
  /** For user turns: absolute URL to fetch the recording. */
  audioUrl?: string
}

// Wait this long after the last voiced chunk before declaring end-of-utterance.
// 2.5 s leaves room for natural mid-sentence pauses and thinking time —
// users were getting cut off mid-thought at the previous 1.2 s. The
// per-chunk VAD fix means the deadline keeps refreshing while you're
// still speaking, so a longer threshold doesn't add latency to actively
// spoken turns; it only delays the EOU after you've truly stopped.
const SILENCE_THRESHOLD_MS = 2500
// Only fire EOU once the user has said at least this much in this turn —
// guards against single-frame mic noise creating empty turns.
const MIN_VOICED_MS = 300
const CHUNK_MS = 64

export default function CallPage() {
  const { t } = useTranslation()
  const { data: voices = [] } = useVoices()
  // Make the call page a first-class voice picker — user shouldn't have
  // to leave for /library to switch the voice the agent speaks in.
  const [selectedVoice, setSelectedVoice] = useAtom(selectedVoiceAtom)
  const voiceId = selectedVoice ?? voices[0]?.voice_id ?? "default"

  const [state, setState] = React.useState<ConvState>("idle")
  const [connected, setConnected] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [turns, setTurns] = React.useState<Turn[]>([])
  const [stats, setStats] = React.useState<{ ttfa_ms: number; total_ms: number } | null>(null)
  const [hasMic, setHasMic] = React.useState<boolean | null>(null)

  const clientRef = React.useRef<ConversationClient | null>(null)
  const lastVoiceTsRef = React.useRef<number>(0)
  const voicedMsRef = React.useRef<number>(0)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  // Pre-flight mic check
  React.useEffect(() => {
    let cancelled = false
    if (!navigator.mediaDevices?.enumerateDevices) {
      setHasMic(false)
      return
    }
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (cancelled) return
        setHasMic(devices.some((d) => d.kind === "audioinput"))
      })
      .catch(() => !cancelled && setHasMic(null))
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-scroll to bottom whenever a new turn lands.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [turns.length])

  const handleMicChunk = React.useCallback(
    (pcm: ArrayBuffer, speaking: boolean) => {
      clientRef.current?.sendAudioChunk(pcm)
      const now = performance.now()
      if (speaking) {
        lastVoiceTsRef.current = now
        voicedMsRef.current += CHUNK_MS
      }
      if (
        lastVoiceTsRef.current > 0 &&
        voicedMsRef.current >= MIN_VOICED_MS &&
        now - lastVoiceTsRef.current > SILENCE_THRESHOLD_MS
      ) {
        lastVoiceTsRef.current = 0
        voicedMsRef.current = 0
        clientRef.current?.endOfUtterance()
      }
    },
    []
  )

  const mic = useMicCapture({
    onChunk: handleMicChunk,
    onSpeakingChange: () => undefined,
  })

  const start = async () => {
    setError(null)
    setTurns([])
    try {
      await mic.start()
    } catch (e) {
      setError((e as Error).message)
      return
    }
    const client = new ConversationClient(
      {
        onState: setState,
        onTranscript: (info) => {
          // Resolve absolute URL for audio playback (proxied through Caddy
          // in production, falls through Vite proxy in dev).
          const fullUrl = info.audioUrl
            ? buildAbsoluteUrl(info.audioUrl)
            : undefined
          setTurns((p) => {
            // If this is a `late` transcript (background ASR), find the
            // matching pending user bubble (same turn idx, empty text)
            // and update it in-place — preserves chat order.
            if (info.late && info.turn !== undefined) {
              const idx = p.findIndex(
                (t) => t.role === "user" && t.turn === info.turn
              )
              if (idx >= 0) {
                const next = [...p]
                next[idx] = {
                  ...next[idx],
                  text: info.text,
                  audioUrl: fullUrl ?? next[idx].audioUrl,
                }
                return next
              }
            }
            // Fresh user turn — append.
            return [
              ...p,
              {
                role: "user",
                text: info.text,
                ts: Date.now(),
                turn: info.turn,
                audioUrl: fullUrl,
              },
            ]
          })
        },
        onResponseText: (text) =>
          setTurns((p) => [...p, { role: "assistant", text, ts: Date.now() }]),
        onTurnDone: (info) =>
          setStats({ ttfa_ms: info.ttfa_ms, total_ms: info.total_ms }),
        onError: (msg) => setError(msg),
      },
      { voiceId, language: "ar" }
    )
    try {
      await client.connect()
      clientRef.current = client
      setConnected(true)
      client.startListening()
    } catch (e) {
      setError((e as Error).message)
      client.close()
      mic.stop()
    }
  }

  const hangup = () => {
    lastVoiceTsRef.current = 0
    voicedMsRef.current = 0
    mic.stop()
    clientRef.current?.close()
    clientRef.current = null
    setConnected(false)
    setState("idle")
  }

  const reset = () => {
    clientRef.current?.reset()
    lastVoiceTsRef.current = 0
    voicedMsRef.current = 0
    setTurns([])
    setStats(null)
  }

  React.useEffect(() => {
    return () => {
      mic.stop()
      clientRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stateLabel = (() => {
    switch (state) {
      case "listening":
        return t("call.state_listening")
      case "thinking":
        return t("call.state_thinking")
      case "speaking":
        return t("call.state_speaking")
      default:
        return connected ? t("call.state_idle") : t("call.state_disconnected")
    }
  })()

  const stateColor = (() => {
    switch (state) {
      case "listening":
        return "text-emerald-500"
      case "thinking":
        return "text-amber-500"
      case "speaking":
        return "text-primary"
      default:
        return "text-muted-foreground"
    }
  })()

  const formatTime = (ts: number) =>
    new Intl.DateTimeFormat("ar", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ts))

  // Layout = full viewport under the nav, split into scroll + bottom bar.
  // We use h-[calc(100svh-3.5rem)] because NavBar is h-14 (3.5rem).
  return (
    <div className="-mx-4 -my-6 flex h-[calc(100svh-3.5rem)] flex-col sm:-mx-6">
      {/* Scrollable chat area — newest message at the bottom (chat-like) */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 sm:px-6"
      >
        <div className="mx-auto flex min-h-full max-w-3xl flex-col">
          {turns.length === 0 ? (
            <EmptyState
              connected={connected}
              hasMic={hasMic}
              voiceName={voices.find((v) => v.voice_id === voiceId)?.name ?? voiceId}
              error={error}
            />
          ) : (
            <>
              {/* Spacer pushes messages to the BOTTOM when content is short */}
              <div className="flex-1 min-h-4" />
              <div className="flex flex-col gap-3 pb-4 pt-6">
                {turns.map((turn, i) => (
                  <ChatBubble key={i} turn={turn} formatTime={formatTime} />
                ))}
                {(state === "thinking" || state === "speaking") && <TypingBubble state={state} />}
                {error && (
                  <div className="mx-auto flex max-w-md items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Sticky bottom control bar */}
      <div className="border-t border-border/60 bg-background/95 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {/* Status pill */}
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-block size-2 rounded-full",
                  state === "listening"
                    ? "bg-emerald-500 animate-pulse"
                    : state === "thinking"
                      ? "bg-amber-500 animate-pulse"
                      : state === "speaking"
                        ? "bg-primary animate-pulse"
                        : "bg-muted-foreground/40"
                )}
              />
              <span className={cn("font-medium", stateColor)}>{stateLabel}</span>
            </div>
            {stats && (
              <span className="tabular-nums text-muted-foreground">
                TTFA {stats.ttfa_ms} ms · إجمالي {stats.total_ms} ms
              </span>
            )}
          </div>

          {/* Controls */}
          {!connected ? (
            <div className="flex flex-col gap-2">
              {/* Pick the agent's voice without leaving the page. */}
              <VoicePicker
                voices={voices}
                value={selectedVoice}
                onValueChange={setSelectedVoice}
              />
              <Button
                size="lg"
                onClick={start}
                disabled={hasMic === false}
                className="w-full"
              >
                <Mic className="me-2 size-5" />
                {t("call.start")}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Button
                size="lg"
                variant={mic.isRecording ? "secondary" : "default"}
                onClick={() => (mic.isRecording ? mic.stop() : void mic.start())}
                className="min-h-12"
              >
                {mic.isRecording ? (
                  <MicOff className="size-5" />
                ) : (
                  <Mic className="size-5" />
                )}
                <span className="ms-2 hidden sm:inline">
                  {mic.isRecording ? t("call.mute") : t("call.unmute")}
                </span>
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={reset}
                className="min-h-12"
              >
                <RotateCcw className="size-5" />
                <span className="ms-2 hidden sm:inline">{t("call.reset")}</span>
              </Button>
              <Button
                size="lg"
                variant="destructive"
                onClick={hangup}
                className="min-h-12"
              >
                <PhoneOff className="size-5" />
                <span className="ms-2 hidden sm:inline">{t("call.hangup")}</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ChatBubble({
  turn,
  formatTime,
}: {
  turn: Turn
  formatTime: (ts: number) => string
}) {
  const { t } = useTranslation()
  const isUser = turn.role === "user"
  return (
    <div className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm sm:max-w-[75%]",
          isUser
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-card border"
        )}
      >
        {/* User bubble: inline audio player above the transcript so the
           user can play back exactly what was sent. */}
        {isUser && turn.audioUrl && (
          <audio
            controls
            preload="metadata"
            src={turn.audioUrl}
            className="w-full max-w-xs rounded-lg"
            style={{ accentColor: "currentColor" }}
          />
        )}
        <span dir="auto">{turn.text || (isUser ? "..." : "")}</span>
      </div>
      <span className="mt-1 px-1 text-[10px] text-muted-foreground">
        {isUser ? t("call.you") : t("call.assistant")} · {formatTime(turn.ts)}
      </span>
    </div>
  )
}

/**
 * Build an absolute URL the browser can use to fetch a session asset.
 * In dev it goes through Vite's /v1 proxy; in prod it goes through Caddy
 * which already proxies /v1/* to the backend.
 */
function buildAbsoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const origin = BACKEND_URL || `${window.location.protocol}//${window.location.host}`
  const sep = path.includes("?") ? "&" : "?"
  // Audio fetch is a normal HTTP GET — Caddy + auth dependency expects
  // the api key as a header, but <audio> can't set headers, so we pass
  // it as a query param too.
  const auth = API_KEY ? `${sep}api_key=${encodeURIComponent(API_KEY)}` : ""
  return `${origin}${path}${auth}`
}

function TypingBubble({ state }: { state: ConvState }) {
  const { t } = useTranslation()
  const text =
    state === "thinking" ? t("call.state_thinking") : t("call.state_speaking")
  return (
    <div className="flex items-start">
      <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border bg-card px-4 py-2.5 text-sm text-muted-foreground shadow-sm">
        <span className="flex gap-1">
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current" />
        </span>
        <span>{text}</span>
      </div>
    </div>
  )
}

function EmptyState({
  connected,
  hasMic,
  voiceName,
  error,
}: {
  connected: boolean
  hasMic: boolean | null
  voiceName: string
  error: string | null
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 py-12">
      <div className="size-32">
        <Orb agentState={connected ? "thinking" : "idle"} />
      </div>
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">{t("call.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {connected ? `الصوت: ${voiceName}` : t("call.subtitle")}
        </p>
      </div>
      {hasMic === false && (
        <div className="flex max-w-md items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div>
            لا يوجد ميكروفون متصل بهذا الجهاز. افتح الصفحة من جوالك أو لابتوبك.
          </div>
        </div>
      )}
      {error && (
        <div className="flex max-w-md items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
