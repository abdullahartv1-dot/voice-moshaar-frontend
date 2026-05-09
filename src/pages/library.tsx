import * as React from "react"
import { useAtom } from "jotai"
import { useTranslation } from "react-i18next"
import { Loader2, Pause, Play, Trash2, Wand2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import {
  AudioPlayerProvider,
  useAudioPlayer,
} from "@/components/ui/audio-player"
import { VoicePicker } from "@/components/ui/voice-picker"
import { Orb } from "@/components/ui/orb"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { useDeleteVoice, useTTS, useVoices } from "@/api/hooks"
import { selectedVoiceAtom } from "@/store/atoms"
import { cn } from "@/lib/utils"

export default function LibraryPage() {
  return (
    <AudioPlayerProvider>
      <LibraryInner />
    </AudioPlayerProvider>
  )
}

function LibraryInner() {
  const { t } = useTranslation()
  const { data: voices = [], isLoading } = useVoices()
  const [selectedId, setSelectedId] = useAtom(selectedVoiceAtom)
  const [text, setText] = React.useState("")
  const [cfg, setCfg] = React.useState(1.8)
  const [steps, setSteps] = React.useState(15)
  const [generatedUrl, setGeneratedUrl] = React.useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null)

  const tts = useTTS()
  const del = useDeleteVoice()
  const player = useAudioPlayer()

  // Make sure a voice is selected once data loads.
  React.useEffect(() => {
    if (!selectedId && voices.length > 0) {
      const def = voices.find((v) => v.voice_id === "default") || voices[0]
      if (def) setSelectedId(def.voice_id)
    }
  }, [voices, selectedId, setSelectedId])

  // Free the previous blob when we replace it.
  React.useEffect(() => {
    return () => {
      if (generatedUrl) URL.revokeObjectURL(generatedUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedUrl])

  const handleGenerate = async () => {
    if (!selectedId || !text.trim()) return
    try {
      const blob = await tts.mutateAsync({
        voiceId: selectedId,
        req: {
          text,
          voice_settings: { cfg_scale: cfg, diffusion_steps: steps },
        },
      })
      const url = URL.createObjectURL(blob)
      setGeneratedUrl(url)
      player.play({ id: "generated", src: url })
    } catch (e) {
      console.error(e)
    }
  }

  const generatedActive = player.isItemActive("generated")
  const isPlayingGenerated = generatedActive && player.isPlaying

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t("library.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("library.subtitle")}</p>
      </header>

      <section className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        {/* Voice picker + list */}
        <div className="space-y-3">
          <VoicePicker
            voices={voices}
            value={selectedId}
            onValueChange={setSelectedId}
          />
          <div className="rounded-lg border bg-card p-2">
            {isLoading ? (
              <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
                <Loader2 className="me-2 size-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : (
              <ul className="max-h-[480px] space-y-1 overflow-y-auto">
                {voices.map((v) => {
                  const active = selectedId === v.voice_id
                  return (
                    <li key={v.voice_id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedId(v.voice_id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            setSelectedId(v.voice_id)
                          }
                        }}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-3 rounded-md p-2 text-start transition-colors",
                          active ? "bg-accent" : "hover:bg-accent/50"
                        )}
                      >
                        <div className="size-8 shrink-0">
                          <Orb agentState={active ? "thinking" : "idle"} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-sm font-medium">{v.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {v.dur_s.toFixed(1)}s · {v.language.toUpperCase()}
                          </div>
                        </div>
                        {v.voice_id !== "default" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setPendingDelete(v.voice_id)
                            }}
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t("library.delete")}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        {/* TTS form */}
        <div className="space-y-4 rounded-lg border bg-card p-4 sm:p-6">
          <div className="space-y-2">
            <Label htmlFor="tts-text">{t("library.tts_input")}</Label>
            <Textarea
              id="tts-text"
              dir="auto"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("library.tts_input")}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>CFG scale</Label>
                <span className="text-sm tabular-nums text-muted-foreground">{cfg.toFixed(1)}</span>
              </div>
              <Slider
                min={1}
                max={3}
                step={0.1}
                value={[cfg]}
                onValueChange={([v]) => v !== undefined && setCfg(v)}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Diffusion steps</Label>
                <span className="text-sm tabular-nums text-muted-foreground">{steps}</span>
              </div>
              <Slider
                min={5}
                max={60}
                step={1}
                value={[steps]}
                onValueChange={([v]) => v !== undefined && setSteps(v)}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={handleGenerate}
              disabled={!selectedId || !text.trim() || tts.isPending}
              className="min-w-[140px]"
            >
              {tts.isPending ? (
                <>
                  <Loader2 className="me-2 size-4 animate-spin" />
                  {t("library.tts_generating")}
                </>
              ) : (
                <>
                  <Wand2 className="me-2 size-4" />
                  {t("library.tts_generate")}
                </>
              )}
            </Button>

            {generatedUrl && (
              <Button
                variant="outline"
                onClick={() => {
                  if (isPlayingGenerated) player.pause()
                  else player.play({ id: "generated", src: generatedUrl })
                }}
              >
                {isPlayingGenerated ? (
                  <>
                    <Pause className="me-2 size-4" />
                    {t("library.tts_pause")}
                  </>
                ) : (
                  <>
                    <Play className="me-2 size-4" />
                    {t("library.tts_play")}
                  </>
                )}
              </Button>
            )}
          </div>

          {tts.error && (
            <p className="text-sm text-destructive">{(tts.error as Error).message}</p>
          )}
        </div>
      </section>

      <Dialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("library.delete")}</DialogTitle>
            <DialogDescription>{t("library.delete_confirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (pendingDelete) {
                  await del.mutateAsync(pendingDelete)
                  if (selectedId === pendingDelete) setSelectedId(null)
                  setPendingDelete(null)
                }
              }}
            >
              {del.isPending ? <Loader2 className="me-2 size-4 animate-spin" /> : null}
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
