import * as React from "react"
import { useTranslation } from "react-i18next"
import { Loader2, Plus, Trash2, Wand2, Pause, Play, Download } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Orb } from "@/components/ui/orb"
import { VoicePicker } from "@/components/ui/voice-picker"
import {
  AudioPlayerProvider,
  useAudioPlayer,
} from "@/components/ui/audio-player"
import { useDialogue, useVoices } from "@/api/hooks"
import { cn } from "@/lib/utils"

const MAX_SPEAKERS = 4

interface Line {
  id: string
  speaker: number
  text: string
}

export default function DialoguePage() {
  return (
    <AudioPlayerProvider>
      <DialogueInner />
    </AudioPlayerProvider>
  )
}

function DialogueInner() {
  const { t } = useTranslation()
  const { data: voices = [] } = useVoices()

  // 2 default speakers — pick the first two distinct voices.
  const initialSpeakers = React.useMemo(() => {
    const ids = voices.length >= 2 ? [voices[0]!.voice_id, voices[1]!.voice_id] : ["default", "default"]
    return ids
  }, [voices])

  const [speakers, setSpeakers] = React.useState<string[]>(initialSpeakers)
  React.useEffect(() => {
    // Seed once voices arrive
    if (voices.length > 0 && speakers.every((s) => s === "default")) {
      setSpeakers(initialSpeakers)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices])

  const [lines, setLines] = React.useState<Line[]>([
    { id: crypto.randomUUID(), speaker: 1, text: "السلام عليكم. كيف يمكنني مساعدتك؟" },
    { id: crypto.randomUUID(), speaker: 2, text: "أهلاً. أريد فتح حساب جديد." },
  ])

  const [generatedUrl, setGeneratedUrl] = React.useState<string | null>(null)
  const [genMs, setGenMs] = React.useState<number | null>(null)
  const dialogue = useDialogue()
  const player = useAudioPlayer()

  React.useEffect(() => {
    return () => {
      if (generatedUrl) URL.revokeObjectURL(generatedUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatedUrl])

  const setSpeaker = (idx: number, voiceId: string) => {
    setSpeakers((p) => p.map((v, i) => (i === idx ? voiceId : v)))
  }
  const addSpeaker = () => {
    if (speakers.length >= MAX_SPEAKERS) return
    setSpeakers((p) => [...p, voices[0]?.voice_id ?? "default"])
  }
  const removeSpeaker = () => {
    if (speakers.length <= 1) return
    const newCount = speakers.length - 1
    setSpeakers((p) => p.slice(0, -1))
    // Reassign any line referring to the removed speaker
    setLines((p) => p.map((l) => (l.speaker > newCount ? { ...l, speaker: 1 } : l)))
  }

  const addLine = () => {
    setLines((p) => [
      ...p,
      { id: crypto.randomUUID(), speaker: ((p.length % speakers.length) + 1), text: "" },
    ])
  }
  const removeLine = (id: string) => {
    setLines((p) => p.filter((l) => l.id !== id))
  }
  const updateLine = (id: string, patch: Partial<Line>) => {
    setLines((p) => p.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  const canGenerate =
    speakers.length >= 1 &&
    lines.length >= 1 &&
    lines.every((l) => l.text.trim().length > 0) &&
    !dialogue.isPending

  const handleGenerate = async () => {
    const t0 = performance.now()
    const blob = await dialogue.mutateAsync({
      speakers,
      lines: lines.map((l) => ({ speaker: l.speaker, text: l.text.trim() })),
    })
    const url = URL.createObjectURL(blob)
    setGeneratedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
    setGenMs(Math.round(performance.now() - t0))
    player.play({ id: "dialogue", src: url })
  }

  const isPlayingDialogue = player.isItemActive("dialogue") && player.isPlaying

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t("dialogue.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("dialogue.subtitle")}</p>
      </header>

      <section className="space-y-3 rounded-lg border bg-card p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <Label>{t("dialogue.speakers")}</Label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={removeSpeaker}
              disabled={speakers.length <= 1}
            >
              <Trash2 className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addSpeaker}
              disabled={speakers.length >= MAX_SPEAKERS}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {speakers.map((sid, idx) => (
            <div key={idx} className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("dialogue.speaker_n", { n: idx + 1 })}
              </Label>
              <VoicePicker
                voices={voices}
                value={sid}
                onValueChange={(v) => setSpeaker(idx, v)}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <Label>{t("dialogue.lines")}</Label>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="me-1 size-3.5" />
            {t("dialogue.add_line")}
          </Button>
        </div>
        <ol className="space-y-3">
          {lines.map((line) => (
            <li
              key={line.id}
              className="flex flex-col gap-2 rounded-md border bg-background/40 p-3 sm:flex-row"
            >
              <div className="flex shrink-0 items-start gap-2">
                <div className="size-9 shrink-0">
                  <Orb agentState="idle" />
                </div>
                <select
                  value={line.speaker}
                  onChange={(e) => updateLine(line.id, { speaker: Number(e.target.value) })}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  {speakers.map((_, i) => (
                    <option key={i} value={i + 1}>
                      {t("dialogue.speaker_n", { n: i + 1 })}
                    </option>
                  ))}
                </select>
              </div>
              <Textarea
                dir="auto"
                rows={2}
                placeholder={t("dialogue.line_placeholder")}
                value={line.text}
                onChange={(e) => updateLine(line.id, { text: e.target.value })}
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeLine(line.id)}
                disabled={lines.length <= 1}
                aria-label={t("dialogue.remove_line")}
                className="shrink-0"
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ol>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleGenerate} disabled={!canGenerate} className="min-w-[180px]">
          {dialogue.isPending ? (
            <>
              <Loader2 className="me-2 size-4 animate-spin" />
              {t("dialogue.generating")}
            </>
          ) : (
            <>
              <Wand2 className="me-2 size-4" />
              {t("dialogue.generate")}
            </>
          )}
        </Button>

        {generatedUrl && (
          <>
            <Button
              variant="outline"
              onClick={() => {
                if (isPlayingDialogue) player.pause()
                else player.play({ id: "dialogue", src: generatedUrl })
              }}
            >
              {isPlayingDialogue ? (
                <>
                  <Pause className="me-2 size-4" />
                  {t("dialogue.pause")}
                </>
              ) : (
                <>
                  <Play className="me-2 size-4" />
                  {t("dialogue.play")}
                </>
              )}
            </Button>
            <Button variant="ghost" asChild>
              <a href={generatedUrl} download="dialogue.wav">
                <Download className="me-2 size-4" />
                {t("dialogue.download")}
              </a>
            </Button>
          </>
        )}

        {genMs !== null && (
          <span className={cn("text-xs tabular-nums text-muted-foreground")}>
            {t("dialogue.duration")}: {(genMs / 1000).toFixed(1)}s
          </span>
        )}

        {dialogue.error && (
          <span className="text-sm text-destructive">{(dialogue.error as Error).message}</span>
        )}
      </div>
    </div>
  )
}
