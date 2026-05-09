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

const SILENCE_THRESHOLD_MS = 1200 // 1.2s of mic silence ends the utterance

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

  const clientRef = React.useRef<ConversationClient | null>(null)
  const lastVoiceTsRef = React.useRef<number>(0)
  const silenceTimerRef = React.useRef<number | null>(null)

  const handleMicChunk = React.useCallback((pcm: ArrayBuffer) => {
    clientRef.current?.sendAudioChunk(pcm)
    // End-of-utterance: if we last heard speech > SILENCE_THRESHOLD_MS ago,
    // tell the server to start the ASR→LLM→TTS pipeline.
    if (
      lastVoiceTsRef.current > 0 &&
      performance.now() - lastVoiceTsRef.current > SILENCE_THRESHOLD_MS
    ) {
      lastVoiceTsRef.current = 0
      clientRef.current?.endOfUtterance()
    }
  }, [])

  const handleSpeaking = React.useCallback((speaking: boolean) => {
    if (speaking) lastVoiceTsRef.current = performance.now()
  }, [])

  const mic = useMicCapture({
    onChunk: handleMicChunk,
    onSpeakingChange: handleSpeaking,
  })

  const start = async () => {
    setError(null)
    setTurns([])
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
      await mic.start()
      client.startListening()
    } catch (e) {
      setError((e as Error).message)
      client.close()
    }
  }

  const hangup = () => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current)
    silenceTimerRef.current = null
    mic.stop()
    clientRef.current?.close()
    clientRef.current = null
    setConnected(false)
    setState("idle")
  }

  const reset = () => {
    clientRef.current?.reset()
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
        <Button size="lg" onClick={start} className="min-w-[180px]">
          <Mic className="me-2 size-4" />
          {t("call.start")}
        </Button>
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
