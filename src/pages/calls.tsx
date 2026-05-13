/**
 * Calls page (مكالمات) — low-latency live voice via LiveKit Cloud.
 *
 * Pipeline (entirely server-side, the browser only sends/receives audio):
 *   Browser mic → LiveKit room → Agent worker
 *     → Deepgram Nova-3 Multilingual (STT, Arabic)
 *     → OpenAI gpt-5.2-chat-latest with Moshaar MCP tools
 *     → Cartesia Sonic-3 or ElevenLabs Multilingual v2 (TTS)
 *   → audio track back to the browser, auto-played.
 *
 * Differs from /call (محادثة):
 *   1. WebRTC transport (LiveKit), not WebSocket
 *   2. Semantic turn detection on the server — no VAD code here
 *   3. Token comes from /api/livekit-token (Vercel function), never
 *      exposes the LiveKit API secret to the browser
 *
 * MCP credentials: the LiveKit Agent Builder agent has a static MCP
 * config set in its Actions tab, so the user gets Moshaar tools out of
 * the box. The per-user MCP key from the dialog is forwarded as room
 * metadata for when we swap to a custom Python worker that respects it.
 */
import * as React from "react"

import { LiveKitCall, type RealtimeState, type RealtimeTurn } from "@/api/livekit-call"
import { useHaptics } from "@/hooks/useHaptics"
import { useMoshaarMCP } from "@/hooks/useMoshaarMCP"
import { MCPSettingsDialog } from "@/components/mcp-settings-dialog"
import { LiveCallOrb } from "@/components/ui/live-call-orb"
import { Button } from "@/components/ui/button"
import { AlertCircle, KeyRound, Phone, PhoneOff } from "lucide-react"
import { cn } from "@/lib/utils"

type ConnState = "idle" | "connecting" | "active"

const STATE_LABEL: Record<RealtimeState, string> = {
  idle: "غير متصل",
  connecting: "يتصل…",
  listening: "يستمع",
  thinking: "يفكّر",
  speaking: "يتحدث",
}

export default function CallsPage() {
  const [connState, setConnState] = React.useState<ConnState>("idle")
  const [realtimeState, setRealtimeState] = React.useState<RealtimeState>("idle")
  const [turns, setTurns] = React.useState<RealtimeTurn[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [micRms, setMicRms] = React.useState(0)
  const [hasMic, setHasMic] = React.useState<boolean | null>(null)
  const [mcpDialogOpen, setMcpDialogOpen] = React.useState(false)

  const mcp = useMoshaarMCP()
  const haptics = useHaptics()
  const clientRef = React.useRef<LiveKitCall | null>(null)
  const partialAssistantTsRef = React.useRef<number | null>(null)

  // Pre-flight mic check
  React.useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setHasMic(false)
      return
    }
    let cancelled = false
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (!cancelled) {
          setHasMic(devices.some((d) => d.kind === "audioinput"))
        }
      })
      .catch(() => !cancelled && setHasMic(null))
    return () => {
      cancelled = true
    }
  }, [])

  const startCall = async () => {
    setError(null)
    setTurns([])
    setConnState("connecting")
    haptics.light()

    const client = new LiveKitCall({
      onState: (s) => {
        setRealtimeState(s)
        // Haptic when the assistant starts talking — same UX as old client.
        if (s === "speaking") haptics.response()
      },
      onUserTranscript: (text, final) => {
        if (!text || !final) return
        setTurns((p) => [...p, { role: "user", text, ts: Date.now() }])
      },
      onAssistantTranscript: (text, final) => {
        if (!text) return
        setTurns((p) => {
          const last = p[p.length - 1]
          if (last && last.role === "assistant" && last.partial) {
            const updated = [...p]
            updated[updated.length - 1] = {
              ...last,
              text,
              partial: !final,
            }
            return updated
          }
          // First chunk for this assistant turn.
          const ts = partialAssistantTsRef.current ?? Date.now()
          partialAssistantTsRef.current = final ? null : ts
          return [...p, { role: "assistant", text, ts, partial: !final }]
        })
        if (final) partialAssistantTsRef.current = null
      },
      onMicLevel: (rms) => setMicRms(rms),
      onError: (msg) => setError(msg),
    })

    try {
      await client.connect({
        mcpUrl: mcp.isConnected ? mcp.url : undefined,
        mcpKey: mcp.isConnected ? mcp.key : undefined,
      })
      clientRef.current = client
      setConnState("active")
    } catch (e) {
      setError((e as Error).message)
      setConnState("idle")
      try {
        await client.close()
      } catch {
        // ignore
      }
    }
  }

  const endCall = async () => {
    haptics.light()
    const client = clientRef.current
    clientRef.current = null
    setConnState("idle")
    setRealtimeState("idle")
    setMicRms(0)
    partialAssistantTsRef.current = null
    if (client) {
      try {
        await client.close()
      } catch {
        // ignore
      }
    }
  }

  // Teardown on unmount
  React.useEffect(() => {
    return () => {
      void clientRef.current?.close()
    }
  }, [])

  return (
    <>
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
      </Button>

      <MCPSettingsDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} />

      <div
        className="-mx-4 -my-6 flex h-[calc(100svh-3.5rem)] flex-col bg-gradient-to-b from-background to-muted/30 sm:-mx-6"
        dir="rtl"
      >
        {/* Header */}
        <div className="border-b border-border/60 bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <div className="mx-auto flex max-w-3xl items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">مكالمة مباشرة</h2>
              <p className="text-xs text-muted-foreground">
                {connState === "active" ? STATE_LABEL[realtimeState] : "جاهزة للاتصال"}
                {" · "}
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                  livekit + deepgram + cartesia
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Chat history */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6">
          <div className="mx-auto flex max-w-3xl flex-col gap-3 py-4">
            {turns.length === 0 ? (
              <EmptyState connState={connState} hasMic={hasMic} mcp={mcp.isConnected} />
            ) : (
              turns.map((turn, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex flex-col",
                    turn.role === "user" ? "items-end" : "items-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[88%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm",
                      turn.role === "user"
                        ? "rounded-br-sm bg-primary text-primary-foreground"
                        : "rounded-bl-sm border bg-background",
                    )}
                  >
                    {turn.text || "…"}
                    {turn.partial && (
                      <span className="ms-1 inline-block size-1.5 animate-pulse rounded-full bg-current align-middle" />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Error */}
        {(error || hasMic === false) && (
          <div className="border-t border-border/60 bg-background/95 px-4 py-2 sm:px-6">
            <div className="mx-auto flex max-w-3xl items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error || "لا يوجد ميكروفون متصل بهذا الجهاز."}</span>
            </div>
          </div>
        )}

        {/* Orb + connect/end button */}
        <div className="border-t border-border/60 bg-background/95 px-4 py-5 sm:px-6">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-3">
            {connState === "active" ? (
              <LiveCallOrb state={realtimeState === "connecting" ? "idle" : realtimeState} micRms={micRms} size={100} />
            ) : (
              <div className="size-[100px]" /> /* keep height stable */
            )}
            {connState === "idle" ? (
              <Button
                onClick={() => void startCall()}
                disabled={hasMic === false}
                size="lg"
                className="h-12 gap-2 rounded-full px-6"
              >
                <Phone className="size-5" />
                ابدأ المكالمة
              </Button>
            ) : connState === "connecting" ? (
              <Button disabled size="lg" className="h-12 rounded-full px-6">
                يتصل…
              </Button>
            ) : (
              <Button
                onClick={() => void endCall()}
                size="lg"
                variant="destructive"
                className="h-12 gap-2 rounded-full px-6"
              >
                <PhoneOff className="size-5" />
                إنهاء المكالمة
              </Button>
            )}
            <p className="text-[10px] text-muted-foreground">
              تكلّم بشكل طبيعي. النموذج يستمع ويرد مباشرة عبر LiveKit.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

function EmptyState({
  connState,
  hasMic,
  mcp,
}: {
  connState: ConnState
  hasMic: boolean | null
  mcp: boolean
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 py-12 text-center">
      <h3 className="text-base font-semibold">
        {connState === "idle" ? "ابدأ مكالمة مباشرة" : "تكلّم الآن"}
      </h3>
      <p className="text-xs text-muted-foreground">
        {hasMic === false
          ? "لا يوجد ميكروفون — افتح من جوالك."
          : connState === "idle"
            ? "اضغط زر 'ابدأ المكالمة' للاتصال بمساعدة ساره"
            : "أنت متصل. تكلّم بشكل طبيعي."}
      </p>
      {!mcp && (
        <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
          ⚠️ مستشار غير مربوط — لن يستطيع الوصول للمهام/التقويم
        </p>
      )}
    </div>
  )
}
