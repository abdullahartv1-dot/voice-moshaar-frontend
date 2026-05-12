import * as React from "react"
import { useAtom } from "jotai"

import {
  ChatCallView,
  type ChatCallTurn,
} from "@/components/ui/chat-call-view"
import { useVoices, useHealth } from "@/api/hooks"
import { ConversationClient, type ConvState } from "@/api/conversation-ws"
import { useMicCapture } from "@/hooks/useMicCapture"
import { useHaptics } from "@/hooks/useHaptics"
import { selectedVoiceAtom } from "@/store/atoms"
import { BACKEND_URL, API_KEY } from "@/api/client"
import { MCPSettingsDialog } from "@/components/mcp-settings-dialog"
import { useMoshaarMCP } from "@/hooks/useMoshaarMCP"
import { Button } from "@/components/ui/button"
import { KeyRound } from "lucide-react"

// Per-chunk VAD silence threshold for live-call mode. 2.5 s leaves room
// for mid-sentence pauses but ends the turn promptly once the user
// stops talking.
const SILENCE_THRESHOLD_MS = 2000
const MIN_VOICED_MS = 300
const CHUNK_MS = 64
// Voice-note (press-and-hold) safety cap — the recording auto-commits
// after this much audio so the user can't accidentally leave the mic
// open for minutes.
const VOICE_NOTE_MAX_MS = 60_000

type RecState = "idle" | "recording" | "sending"

export default function CallPage() {
  const { data: voices = [] } = useVoices()
  const [selectedVoice, setSelectedVoice] = useAtom(selectedVoiceAtom)
  const voiceId = selectedVoice ?? voices[0]?.voice_id ?? "default"

  // ── Conversation state ──
  const [state, setState] = React.useState<ConvState>("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [turns, setTurns] = React.useState<ChatCallTurn[]>([])
  const [stats, setStats] = React.useState<{ ttfa_ms: number; total_ms: number } | null>(null)
  const [hasMic, setHasMic] = React.useState<boolean | null>(null)
  const [micRms, setMicRms] = React.useState(0)

  // ── Live-call mode (continuous streaming) ──
  const [liveCallActive, setLiveCallActive] = React.useState(false)

  // ── Voice-note (press-and-hold) recording state ──
  const [recordingState, setRecordingState] = React.useState<RecState>("idle")
  const voiceNoteCancelRef = React.useRef(false)
  const voiceNoteTimeoutRef = React.useRef<number | null>(null)

  // ── MCP credentials (per-user) ──
  const mcp = useMoshaarMCP()
  const [mcpDialogOpen, setMcpDialogOpen] = React.useState(false)

  // ── Health (LLM backend badge) ──
  const { data: health } = useHealth()
  const llmBackendBadge = React.useMemo(() => {
    if (!health) return undefined
    const backend = (health as { llm_backend?: string }).llm_backend
    return backend === "openai" ? "openai" : "gemma"
  }, [health])

  const haptics = useHaptics()

  const clientRef = React.useRef<ConversationClient | null>(null)
  const lastVoiceTsRef = React.useRef<number>(0)
  const voicedMsRef = React.useRef<number>(0)

  // ── Pre-flight mic check ──
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

  // ── Mic chunk handler — feeds the WS during BOTH live call AND voice note ──
  const handleMicChunk = React.useCallback(
    (pcm: ArrayBuffer, speaking: boolean, rms: number) => {
      setMicRms(rms)
      if (!clientRef.current) return
      clientRef.current.sendAudioChunk(pcm)

      // Live-call mode: VAD-driven EOU
      if (liveCallActive) {
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
          clientRef.current.endOfUtterance()
        }
      }
    },
    [liveCallActive],
  )

  const mic = useMicCapture({
    onChunk: handleMicChunk,
    onSpeakingChange: () => undefined,
  })

  // ── WS connection helper (lazy — only connects on first interaction) ──
  const ensureConnection = React.useCallback(async (): Promise<ConversationClient> => {
    if (clientRef.current) return clientRef.current

    const client = new ConversationClient(
      {
        onState: setState,
        onTranscript: (info) => {
          const fullUrl = info.audioUrl ? buildAbsoluteUrl(info.audioUrl) : undefined
          setTurns((p) => [
            ...p,
            {
              role: "user",
              text: info.text,
              ts: Date.now(),
              turn: info.turn,
              audioUrl: fullUrl,
            },
          ])
        },
        onResponseText: (text) => {
          setTurns((p) => [...p, { role: "assistant", text, ts: Date.now() }])
          // Double-tap haptic when the AI's text response lands (TTS
          // audio is what the user hears, but the text arrives a few
          // ms earlier — good enough to signal "ready").
          haptics.response()
        },
        onTurnDone: (info) => {
          setStats({ ttfa_ms: info.ttfa_ms, total_ms: info.total_ms })
        },
        onError: (msg) => setError(msg),
      },
      {
        voiceId,
        language: "ar",
        mcpUrl: mcp.isConnected ? mcp.url : undefined,
        mcpKey: mcp.isConnected ? mcp.key : undefined,
      },
    )
    await client.connect()
    clientRef.current = client
    return client
  }, [voiceId, mcp.isConnected, mcp.url, mcp.key, haptics])

  // ── Text mode ──
  // Text input → text-only response (no TTS). The user is reading the
  // chat, not listening. If they want spoken replies they use the mic
  // (voice note) or live-call modes.
  const handleSendText = React.useCallback(
    async (content: string) => {
      setError(null)
      setTurns((p) => [...p, { role: "user", text: content, ts: Date.now() }])
      haptics.send()
      try {
        const client = await ensureConnection()
        client.sendText(content, { speak: false })
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [ensureConnection, haptics],
  )

  // ── Voice-note (press-and-hold) ──
  // We open the mic on press, stream audio to the WS, then fire
  // end_of_utterance on release. The WS pipeline is the same one
  // live-call uses; just without VAD-driven EOU.
  const startVoiceNote = React.useCallback(async () => {
    setError(null)
    voiceNoteCancelRef.current = false
    haptics.light()
    try {
      await ensureConnection()
      if (!mic.isRecording) {
        await mic.start()
      }
      setRecordingState("recording")
      // Auto-commit safety cap
      if (voiceNoteTimeoutRef.current) {
        window.clearTimeout(voiceNoteTimeoutRef.current)
      }
      voiceNoteTimeoutRef.current = window.setTimeout(() => {
        stopVoiceNote(false)
      }, VOICE_NOTE_MAX_MS)
    } catch (e) {
      setError((e as Error).message)
      setRecordingState("idle")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureConnection, mic, haptics])

  const stopVoiceNote = React.useCallback(
    (cancelled: boolean) => {
      if (voiceNoteTimeoutRef.current) {
        window.clearTimeout(voiceNoteTimeoutRef.current)
        voiceNoteTimeoutRef.current = null
      }
      // Don't stop the mic if live-call is ongoing — it owns the mic.
      if (!liveCallActive) {
        mic.stop()
      }
      if (cancelled) {
        setRecordingState("idle")
        return
      }
      // Trigger ASR + LLM on the server
      try {
        clientRef.current?.endOfUtterance()
        haptics.send()
        setRecordingState("sending")
        // Reset to idle once the response starts coming back
        setTimeout(() => setRecordingState("idle"), 600)
      } catch (e) {
        setError((e as Error).message)
        setRecordingState("idle")
      }
    },
    [mic, liveCallActive, haptics],
  )

  // ── Live-call toggle ──
  const startLiveCall = React.useCallback(async () => {
    setError(null)
    haptics.light()
    try {
      await ensureConnection()
      if (!mic.isRecording) {
        await mic.start()
      }
      setLiveCallActive(true)
      clientRef.current?.startListening()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [ensureConnection, mic, haptics])

  const stopLiveCall = React.useCallback(() => {
    haptics.light()
    lastVoiceTsRef.current = 0
    voicedMsRef.current = 0
    mic.stop()
    setLiveCallActive(false)
    setState("idle")
    setMicRms(0)
    // Keep the WS open in case the user wants to send text/voice-note next.
  }, [mic, haptics])

  const toggleLiveCall = React.useCallback(() => {
    if (liveCallActive) stopLiveCall()
    else void startLiveCall()
  }, [liveCallActive, startLiveCall, stopLiveCall])

  // ── Tear down on unmount ──
  React.useEffect(() => {
    return () => {
      mic.stop()
      clientRef.current?.close()
      clientRef.current = null
      if (voiceNoteTimeoutRef.current) {
        window.clearTimeout(voiceNoteTimeoutRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      {/* Floating MCP connect button — always visible above the chat */}
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

      <MCPSettingsDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} />

      <ChatCallView
        state={state}
        micRms={micRms}
        turns={turns}
        voices={voices}
        selectedVoice={voiceId}
        onSelectedVoiceChange={setSelectedVoice}
        hasMic={hasMic}
        error={error}
        liveCallActive={liveCallActive}
        recordingState={recordingState}
        onSendText={handleSendText}
        onVoiceNoteStart={startVoiceNote}
        onVoiceNoteStop={stopVoiceNote}
        onLiveCallToggle={toggleLiveCall}
        stats={stats}
        llmBackendBadge={llmBackendBadge}
        mcpConnected={mcp.isConnected}
      />
    </>
  )
}

/**
 * Convert a server-relative path (`/v1/conversation/sessions/.../audio.wav`)
 * to an absolute URL the browser can fetch. The api key goes in the
 * query string because <audio> can't set custom headers.
 */
function buildAbsoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const origin = BACKEND_URL || `${window.location.protocol}//${window.location.host}`
  const sep = path.includes("?") ? "&" : "?"
  const auth = API_KEY ? `${sep}api_key=${encodeURIComponent(API_KEY)}` : ""
  return `${origin}${path}${auth}`
}
