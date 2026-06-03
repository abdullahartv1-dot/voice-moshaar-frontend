/**
 * Calls page (مكالمات) — side-by-side LiveKit vs Deepgram comparison.
 *
 * Two voice paths, one UI:
 *   LiveKit  → WebRTC → server-side Sara agent (agent.py)
 *               ↳ Deepgram nova-3 STT + OpenAI LLM + ElevenLabs TTS
 *   Deepgram → WebSocket → Deepgram Voice Agent
 *               ↳ identical models/voice configured client-side
 *
 * Both paths run with:
 *   - Sara's full Arabic prompt (lib/sara-prompt.ts is the SOT)
 *   - eleven_multilingual_v2 voice cgSgspJ2msm6clMCkdW9
 *   - Same MCP credentials in the future (phase-2 wires function calling
 *     into the Deepgram side; phase 1 LiveKit has MCP, Deepgram doesn't —
 *     fine for measuring voice latency, unfair for measuring feature
 *     parity)
 *
 * Metric on screen:
 *   TTFA = ms from "user stopped speaking" → "first byte of agent audio".
 *   This is the number you actually feel as a caller.
 */
import * as React from "react"

import { DeepgramCall } from "@/api/deepgram-call"
import { LiveKitCall, type RealtimeState, type RealtimeTurn } from "@/api/livekit-call"
import { OmniVoiceCall } from "@/api/omnivoice-call"
import { useHaptics } from "@/hooks/useHaptics"
import { useMoshaarMCP } from "@/hooks/useMoshaarMCP"
import { MCPSettingsDialog } from "@/components/mcp-settings-dialog"
import { ChatMarkdown } from "@/components/ui/chat-markdown"
import { LiveCallOrb } from "@/components/ui/live-call-orb"
import { Button } from "@/components/ui/button"
import { AlertCircle, KeyRound, Phone, PhoneOff, Zap } from "lucide-react"
import { cn } from "@/lib/utils"

type ConnState = "idle" | "connecting" | "active"
type Provider = "livekit" | "deepgram" | "omnivoice"

interface CallClient {
  close: () => Promise<void>
}

const STATE_LABEL: Record<RealtimeState, string> = {
  idle: "غير متصل",
  connecting: "يتصل…",
  listening: "يستمع",
  thinking: "يفكّر",
  speaking: "يتحدث",
}

const PROVIDER_LABEL: Record<Provider, string> = {
  livekit: "LiveKit",
  deepgram: "Deepgram",
  omnivoice: "OmniVoice",
}

const PROVIDER_NOTE: Record<Provider, string> = {
  livekit: "WebRTC + Sara كاملاً مع MCP",
  deepgram: "WebSocket + Voice Agent (بدون MCP بعد)",
  omnivoice: "STT+LLM عبر Deepgram + TTS بصوت ساره من OmniVoice محلي (RunPod)",
}

const PROVIDER_STORAGE_KEY = "voice-provider"

export default function CallsPage() {
  const [connState, setConnState] = React.useState<ConnState>("idle")
  const [realtimeState, setRealtimeState] = React.useState<RealtimeState>("idle")
  const [turns, setTurns] = React.useState<RealtimeTurn[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [micRms, setMicRms] = React.useState(0)
  const [hasMic, setHasMic] = React.useState<boolean | null>(null)
  const [mcpDialogOpen, setMcpDialogOpen] = React.useState(false)

  // Provider toggle — persisted so reloading doesn't change the test.
  const [provider, setProvider] = React.useState<Provider>(() => {
    if (typeof window === "undefined") return "livekit"
    const stored = window.localStorage.getItem(PROVIDER_STORAGE_KEY)
    if (stored === "deepgram") return "deepgram"
    if (stored === "omnivoice") return "omnivoice"
    return "livekit"
  })
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider)
    }
  }, [provider])

  // Metrics shown live during the call. Reset on each new call.
  const [ttfaMs, setTtfaMs] = React.useState<number | null>(null)
  const [detectedLang, setDetectedLang] = React.useState<string | null>(null)

  const mcp = useMoshaarMCP()
  const haptics = useHaptics()
  const clientRef = React.useRef<CallClient | null>(null)
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
    setTtfaMs(null)
    setDetectedLang(null)
    setConnState("connecting")
    haptics.light()

    const commonCallbacks = {
      onState: (s: RealtimeState) => {
        setRealtimeState(s)
        if (s === "speaking") haptics.response()
      },
      onUserTranscript: (text: string, final: boolean) => {
        if (!text || !final) return
        setTurns((p) => [...p, { role: "user" as const, text, ts: Date.now() }])
      },
      onAssistantTranscript: (text: string, final: boolean) => {
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
          const ts = partialAssistantTsRef.current ?? Date.now()
          partialAssistantTsRef.current = final ? null : ts
          return [
            ...p,
            { role: "assistant" as const, text, ts, partial: !final },
          ]
        })
        if (final) partialAssistantTsRef.current = null
      },
      onMicLevel: (rms: number) => setMicRms(rms),
      onError: (msg: string) => setError(msg),
    }

    const mcpUrl = mcp.isConnected ? mcp.url : undefined
    const mcpKey = mcp.isConnected ? mcp.key : undefined

    let client: CallClient
    try {
      if (provider === "livekit") {
        const c = new LiveKitCall(commonCallbacks)
        await c.connect({ mcpUrl, mcpKey })
        client = c
      } else if (provider === "deepgram") {
        const c = new DeepgramCall({
          ...commonCallbacks,
          onMetric: (m) => {
            if (typeof m.ttfa_ms === "number") setTtfaMs(m.ttfa_ms)
            if (m.detected_language) setDetectedLang(m.detected_language)
          },
        })
        await c.connect({ mcpUrl, mcpKey })
        client = c
      } else {
        const c = new OmniVoiceCall({
          ...commonCallbacks,
          onMetric: (m) => {
            if (typeof m.ttfa_ms === "number") setTtfaMs(m.ttfa_ms)
            if (m.detected_language) setDetectedLang(m.detected_language)
          },
        })
        await c.connect({ mcpUrl, mcpKey })
        client = c
      }
      clientRef.current = client
      setConnState("active")
    } catch (e) {
      setError((e as Error).message)
      setConnState("idle")
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
        {/* Header — same as before, plus a live TTFA chip when active */}
        <div className="border-b border-border/60 bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <div className="mx-auto flex max-w-3xl items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">مكالمة مباشرة</h2>
              <p className="text-xs text-muted-foreground">
                {connState === "active"
                  ? STATE_LABEL[realtimeState]
                  : "جاهزة للاتصال"}
              </p>
            </div>
            {connState === "active" && (
              <div className="flex items-center gap-2 text-xs">
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium">
                  {PROVIDER_LABEL[provider]}
                </span>
                {ttfaMs !== null && (
                  <span
                    className={cn(
                      "flex items-center gap-1 rounded-full px-2 py-0.5 font-mono",
                      ttfaMs < 500
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                        : ttfaMs < 1000
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                          : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
                    )}
                  >
                    <Zap className="size-3" />
                    {ttfaMs}ms
                  </span>
                )}
                {detectedLang && (
                  <span className="rounded-full bg-muted px-2 py-0.5 uppercase">
                    {detectedLang}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Chat history */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6">
          <div className="mx-auto flex max-w-3xl flex-col gap-3 py-4">
            {turns.length === 0 ? (
              <EmptyState
                connState={connState}
                hasMic={hasMic}
                mcp={mcp.isConnected}
                provider={provider}
              />
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
                    {turn.role === "assistant" ? (
                      <ChatMarkdown content={turn.text || "…"} />
                    ) : (
                      <span>{turn.text || "…"}</span>
                    )}
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
              <span>
                {error || "لا يوجد ميكروفون متصل بهذا الجهاز."}
              </span>
            </div>
          </div>
        )}

        {/* Footer: provider toggle when idle, orb when connected */}
        <div className="border-t border-border/60 bg-background/95 px-4 py-4 sm:px-6">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-3">
            {connState === "idle" && (
              <ProviderToggle value={provider} onChange={setProvider} />
            )}

            {connState === "active" ? (
              <LiveCallOrb
                state={
                  realtimeState === "connecting" ? "idle" : realtimeState
                }
                micRms={micRms}
                size={100}
              />
            ) : (
              <div className="size-[100px]" />
            )}

            {connState === "idle" ? (
              <Button
                onClick={() => void startCall()}
                disabled={hasMic === false}
                size="lg"
                className="h-12 gap-2 rounded-full px-6"
              >
                <Phone className="size-5" />
                ابدأ المكالمة عبر {PROVIDER_LABEL[provider]}
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
              تكلّم بشكل طبيعي. ساره تستمع وترد عليك مباشرة.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

function ProviderToggle({
  value,
  onChange,
}: {
  value: Provider
  onChange: (p: Provider) => void
}) {
  const providers: Provider[] = ["livekit", "deepgram", "omnivoice"]
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-2">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        مزوّد الصوت
      </div>
      <div className="inline-flex rounded-full border border-border/60 bg-muted/40 p-1">
        {providers.map((p) => {
          const active = value === p
          return (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={cn(
                "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {PROVIDER_LABEL[p]}
            </button>
          )
        })}
      </div>
      <p className="text-center text-[10px] text-muted-foreground">
        {PROVIDER_NOTE[value]}
      </p>
    </div>
  )
}

function EmptyState({
  connState,
  hasMic,
  mcp,
  provider,
}: {
  connState: ConnState
  hasMic: boolean | null
  mcp: boolean
  provider: Provider
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
            ? `اضغط زر 'ابدأ المكالمة' للاتصال عبر ${PROVIDER_LABEL[provider]}`
            : "أنت متصل. تكلّم بشكل طبيعي."}
      </p>
      {!mcp && provider === "livekit" && (
        <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
          ⚠️ مستشار غير مربوط — لن يستطيع الوصول للمهام/التقويم
        </p>
      )}
      {provider === "deepgram" && (
        <p className="mt-2 text-[10px] text-blue-600 dark:text-blue-400">
          ℹ️ مسار Deepgram (مرحلة 1): مقارنة الصوت + الاستجابة فقط، بلا MCP
        </p>
      )}
    </div>
  )
}
