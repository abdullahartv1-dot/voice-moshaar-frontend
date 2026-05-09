import * as React from "react"
import { useAtomValue } from "jotai"
import { useTranslation } from "react-i18next"
import { Mic, MicOff, PhoneOff, RotateCcw, AlertCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Orb } from "@/components/ui/orb"
import { useVoices } from "@/api/hooks"
import { ConversationClient, type ConvState } from "@/api/conversation-ws"
import { useMicCapture } from "@/hooks/useMicCapture"
import { selectedVoiceAtom } from "@/store/atoms"
import { cn } from "@/lib/utils"

interface Turn {
  role: "user" | "assistant"
  text: string
}

// Wait this long after the LAST voiced chunk before declaring end-of-utterance.
// Natural pauses in Arabic narration sit around 0.5-1 s, so anything below
// that prematurely cuts the user off mid-thought. 1.8 s is patient enough
// for "uh, ..." mid-sentence pauses and short exhales without making the
// turnaround feel sluggish.
const SILENCE_THRESHOLD_MS = 1800
// Don't fire EOU until the user has actually said *something* for at least
// this long total — protects against mic clicks / single-frame noise spikes
// triggering an empty utterance.
const MIN_VOICED_MS = 300

export default function CallPage() {
  const { t } = useTranslation()
  const { data: voices = [] } = useVoices()
  const selectedVoice = useAtomValue(selectedVoiceAtom)
  const voiceId = selectedVoice ?? voices[0]?.voice_id ?? "default"

  const [state, setState] = React.useState<ConvState>("idle")
  const [connected, setConnected] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [turns, setTurns] = React.useState<Turn[]>([])
  const [stats, setStats] = React.useState<{ ttfa_ms: number; total_ms: number } | null>(null)
  const [hasMic, setHasMic] = React.useState<boolean | null>(null)

  const clientRef = React.useRef<ConversationClient | null>(null)
  // When did the user last produce a voiced frame? Updated every chunk
  // (not just at speech-start), so a long sentence keeps refreshing it.
  const lastVoiceTsRef = React.useRef<number>(0)
  // Total cumulative voiced time in the current turn — used to ignore
  // single-frame mic noise that isn't actually speech.
  const voicedMsRef = React.useRef<number>(0)
  const silenceTimerRef = React.useRef<number | null>(null)
  // 64 ms is the worklet's chunk size at 16 kHz. Used to credit voiced time.
  const CHUNK_MS = 64

  // Pre-flight check: does this device even have an audio input?
  // We do it once on mount so the user sees the situation before they
  // click "ابدأ المكالمة" — saves a confusing permission prompt.
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
        const hasAudioInput = devices.some((d) => d.kind === "audioinput")
        setHasMic(hasAudioInput)
      })
      .catch(() => {
        if (!cancelled) setHasMic(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleMicChunk = React.useCallback((pcm: ArrayBuffer, speaking: boolean) => {
    clientRef.current?.sendAudioChunk(pcm)
    const now = performance.now()
    // Refresh the "last voiced" timestamp on EVERY chunk that contains
    // speech — not just transitions. This is the fix for "agent cuts the
    // user off mid-sentence": previously lastVoiceTs was only set at
    // speech-start, so SILENCE_THRESHOLD ran out while the user was still
    // talking continuously.
    if (speaking) {
      lastVoiceTsRef.current = now
      voicedMsRef.current += CHUNK_MS
    }
    // Only treat silence as end-of-utterance after enough voiced content
    // to be a real turn (filters out a single noise-spike "blip").
    if (
      lastVoiceTsRef.current > 0 &&
      voicedMsRef.current >= MIN_VOICED_MS &&
      now - lastVoiceTsRef.current > SILENCE_THRESHOLD_MS
    ) {
      lastVoiceTsRef.current = 0
      voicedMsRef.current = 0
      clientRef.current?.endOfUtterance()
    }
  }, [])

  // Transition events drive UI hints (the orb), not the EOU logic above.
  const handleSpeaking = React.useCallback((_speaking: boolean) => {
    // intentionally empty for now — the per-chunk path handles EOU
  }, [])

  const mic = useMicCapture({
    onChunk: handleMicChunk,
    onSpeakingChange: handleSpeaking,
  })

  const start = async () => {
    setError(null)
    setTurns([])

    // Try to open the mic FIRST — it's the most likely failure point and
    // the error message is more helpful than a generic WS failure.
    try {
      await mic.start()
    } catch (e) {
      setError((e as Error).message)
      return
    }

    const client = new ConversationClient(
      {
        onState: setState,
        onTranscript: (text) => setTurns((p) => [...p, { role: "user", text }]),
        onResponseText: (text) => setTurns((p) => [...p, { role: "assistant", text }]),
        onTurnDone: (info) => setStats({ ttfa_ms: info.ttfa_ms, total_ms: info.total_ms }),
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
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
    silenceTimerRef.current = null
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

  return (
    <div className="flex flex-col items-center gap-8 py-8">
      <header className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">{t("call.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {connected
            ? `الصوت: ${voices.find((v) => v.voice_id === voiceId)?.name ?? voiceId}`
            : t("call.subtitle")}
        </p>
      </header>

      <div className="relative">
        <div
          className={cn(
            "size-48 transition-transform duration-300",
            state === "speaking" && "scale-105"
          )}
        >
          <Orb
            agentState={
              state === "speaking" ? "talking" : state === "thinking" ? "thinking" : "idle"
            }
          />
        </div>
      </div>

      <div className={cn("text-center text-base font-medium", stateColor)}>{stateLabel}</div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="size-4" />
          {error}
        </div>
      )}

      {!connected ? (
        <div className="flex flex-col items-center gap-3">
          {hasMic === false && (
            <div className="flex max-w-md items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div>
                لا يوجد ميكروفون متصل بهذا الجهاز. المكالمة المباشرة تتطلب جهازاً
                فيه ميكروفون. افتح الصفحة من جوالك أو لابتوبك.
              </div>
            </div>
          )}
          <Button
            size="lg"
            onClick={start}
            disabled={hasMic === false}
            className="min-w-[180px]"
          >
            <Mic className="me-2 size-4" />
            {t("call.start")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Button
            size="lg"
            variant={mic.isRecording ? "secondary" : "default"}
            onClick={() => (mic.isRecording ? mic.stop() : void mic.start())}
          >
            {mic.isRecording ? (
              <>
                <MicOff className="me-2 size-4" /> {t("call.mute")}
              </>
            ) : (
              <>
                <Mic className="me-2 size-4" /> {t("call.unmute")}
              </>
            )}
          </Button>
          <Button size="lg" variant="outline" onClick={reset}>
            <RotateCcw className="me-2 size-4" /> {t("call.reset")}
          </Button>
          <Button size="lg" variant="destructive" onClick={hangup}>
            <PhoneOff className="me-2 size-4" /> {t("call.hangup")}
          </Button>
        </div>
      )}

      {stats && (
        <div className="text-xs tabular-nums text-muted-foreground">
          TTFA: {stats.ttfa_ms} ms · إجمالي: {stats.total_ms} ms
        </div>
      )}

      {turns.length > 0 && (
        <div className="w-full max-w-2xl space-y-3 rounded-lg border bg-card p-4">
          {turns.map((turn, i) => (
            <div
              key={i}
              className={cn(
                "flex flex-col gap-1 rounded-md p-3",
                turn.role === "user" ? "bg-secondary/60" : "bg-primary/10 text-foreground"
              )}
            >
              <span className="text-xs font-semibold text-muted-foreground">
                {turn.role === "user" ? t("call.you") : t("call.assistant")}
              </span>
              <span dir="auto" className="text-sm leading-relaxed">
                {turn.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
