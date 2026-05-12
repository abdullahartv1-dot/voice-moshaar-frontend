import * as React from "react"
import { useAtom } from "jotai"

import { CallScreen, type CallTurn } from "@/components/ui/call-screen"
import { useVoices } from "@/api/hooks"
import { ConversationClient, type ConvState } from "@/api/conversation-ws"
import { useMicCapture } from "@/hooks/useMicCapture"
import { selectedVoiceAtom } from "@/store/atoms"
import { BACKEND_URL, API_KEY } from "@/api/client"
import { MCPSettingsDialog } from "@/components/mcp-settings-dialog"
import { useMoshaarMCP } from "@/hooks/useMoshaarMCP"
import { Button } from "@/components/ui/button"
import { KeyRound } from "lucide-react"

// Wait this long after the last voiced chunk before declaring end-of-utterance.
// 2.5 s leaves room for natural mid-sentence pauses and thinking time.
// The per-chunk VAD fix means the deadline keeps refreshing while the user
// is still speaking, so a longer threshold doesn't add latency to actively
// spoken turns; it only delays the EOU after they've truly stopped.
const SILENCE_THRESHOLD_MS = 2500
const MIN_VOICED_MS = 300
const CHUNK_MS = 64

type Mode = "idle" | "active" | "review"

export default function CallPage() {
  const { data: voices = [] } = useVoices()
  const [selectedVoice, setSelectedVoice] = useAtom(selectedVoiceAtom)
  const voiceId = selectedVoice ?? voices[0]?.voice_id ?? "default"

  const [mode, setMode] = React.useState<Mode>("idle")
  const [state, setState] = React.useState<ConvState>("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [turns, setTurns] = React.useState<CallTurn[]>([])
  const [stats, setStats] = React.useState<{ ttfa_ms: number; total_ms: number } | null>(null)
  const [hasMic, setHasMic] = React.useState<boolean | null>(null)
  const [isMuted, setIsMuted] = React.useState(false)
  const [isPaused, setIsPaused] = React.useState(false)
  const [callStartedAt, setCallStartedAt] = React.useState<number | undefined>(undefined)
  // micRms is updated ~15 fps from the worklet. We feed it to the orb +
  // the bottom level meter for instant "I hear you" feedback.
  const [micRms, setMicRms] = React.useState(0)

  // Moshaar MCP per-user credentials (localStorage).  When connected, the
  // backend routes the WS through the MCP-aware voice agent so the user
  // can run platform operations by voice.
  const mcp = useMoshaarMCP()
  const [mcpDialogOpen, setMcpDialogOpen] = React.useState(false)

  const clientRef = React.useRef<ConversationClient | null>(null)
  const lastVoiceTsRef = React.useRef<number>(0)
  const voicedMsRef = React.useRef<number>(0)
  // Mute / pause are driven from refs inside the audio handler so we
  // don't need to recreate it on every toggle.
  const mutedRef = React.useRef(false)
  const pausedRef = React.useRef(false)
  React.useEffect(() => { mutedRef.current = isMuted }, [isMuted])
  React.useEffect(() => { pausedRef.current = isPaused }, [isPaused])

  // Pre-flight mic check so the orb shows the right disabled state
  // BEFORE the user taps it.
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

  const handleMicChunk = React.useCallback(
    (pcm: ArrayBuffer, speaking: boolean, rms: number) => {
      // Update RMS for the orb / meter regardless of mute — the orb
      // should still react to the user's voice visually if they speak
      // while muted (gives a hint they're talking but unheard).
      setMicRms(rms)

      // When muted or paused, swallow the chunk + don't update VAD timers.
      if (mutedRef.current || pausedRef.current) return

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
    [],
  )

  const mic = useMicCapture({
    onChunk: handleMicChunk,
    onSpeakingChange: () => undefined,
  })

  // Tap the orb to start the call.
  const start = async () => {
    setError(null)
    setTurns([])
    setStats(null)
    setIsMuted(false)
    setIsPaused(false)
    setMicRms(0)
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
          // After the unified Whisper+Gemma pipeline, transcripts arrive
          // synchronously (no `late` events ever) — just append. We keep
          // the late-update branch as a fail-safe in case an older
          // backend or a future feature re-introduces it.
          const fullUrl = info.audioUrl ? buildAbsoluteUrl(info.audioUrl) : undefined
          setTurns((p) => {
            if (info.late && info.turn !== undefined) {
              const idx = p.findIndex(
                (t) => t.role === "user" && t.turn === info.turn,
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
      {
        voiceId,
        language: "ar",
        // When the user has configured their Moshaar MCP key, pass it so
        // the backend wires up the MCP-aware voice agent.  Read fresh
        // from the hook each time the call starts.
        mcpUrl: mcp.isConnected ? mcp.url : undefined,
        mcpKey: mcp.isConnected ? mcp.key : undefined,
      },
    )
    try {
      await client.connect()
      clientRef.current = client
      setMode("active")
      setCallStartedAt(Date.now())
      client.startListening()
    } catch (e) {
      setError((e as Error).message)
      client.close()
      mic.stop()
    }
  }

  const endCall = () => {
    lastVoiceTsRef.current = 0
    voicedMsRef.current = 0
    mic.stop()
    clientRef.current?.close()
    clientRef.current = null
    setState("idle")
    setIsMuted(false)
    setIsPaused(false)
    setCallStartedAt(undefined)
    setMicRms(0)
    // Switch to review if anything was said; otherwise back to idle.
    setMode((current) => (turns.length > 0 ? "review" : "idle"))
  }

  const startNew = () => {
    setMode("idle")
    setTurns([])
    setStats(null)
    setError(null)
  }

  const toggleMute = () => {
    setIsMuted((m) => {
      const next = !m
      if (next) {
        // Reset VAD trackers so unmuting later doesn't immediately fire EOU.
        lastVoiceTsRef.current = 0
        voicedMsRef.current = 0
      }
      return next
    })
  }

  const togglePause = () => {
    setIsPaused((p) => {
      const next = !p
      if (next) {
        lastVoiceTsRef.current = 0
        voicedMsRef.current = 0
      }
      return next
    })
  }

  // Tear down on unmount — leaving the page during a call shouldn't
  // leave a stranded WebSocket / mic.
  React.useEffect(() => {
    return () => {
      mic.stop()
      clientRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      {/* Floating MCP connect button — always visible above the call UI. */}
      <Button
        type="button"
        variant={mcp.isConnected ? "default" : "outline"}
        size="sm"
        onClick={() => setMcpDialogOpen(true)}
        className="fixed top-4 left-4 z-40 gap-2 shadow-md"
      >
        <KeyRound className="size-4" />
        <span className="font-medium">
          {mcp.isConnected ? "مستشار متصل" : "ربط مستشار"}
        </span>
        {mcp.isConnected && (
          <span className="ms-1 inline-block size-2 rounded-full bg-emerald-400 animate-pulse" />
        )}
      </Button>

      <MCPSettingsDialog
        open={mcpDialogOpen}
        onOpenChange={setMcpDialogOpen}
      />

      <CallScreen
        mode={mode}
        state={state}
        micRms={micRms}
        voices={voices}
        selectedVoice={voiceId}
        onSelectedVoiceChange={setSelectedVoice}
        callStartedAt={callStartedAt}
        stats={stats}
        error={error}
        hasMic={hasMic}
        turns={turns}
        isMuted={isMuted}
        isPaused={isPaused}
        onStartTap={() => void start()}
        onMuteToggle={toggleMute}
        onPauseToggle={togglePause}
        onEnd={endCall}
        onStartNew={startNew}
      />
    </>
  )
}

/**
 * Convert a server-relative path (`/v1/conversation/sessions/.../audio.wav`)
 * to an absolute URL the browser can fetch. In dev this hits Vite's /v1
 * proxy; in prod it goes through Caddy. We pass the api key as a query
 * param because <audio> can't set custom headers.
 */
function buildAbsoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const origin = BACKEND_URL || `${window.location.protocol}//${window.location.host}`
  const sep = path.includes("?") ? "&" : "?"
  const auth = API_KEY ? `${sep}api_key=${encodeURIComponent(API_KEY)}` : ""
  return `${origin}${path}${auth}`
}
