import * as React from "react"
import { useTranslation } from "react-i18next"
import { Loader2, Upload, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useTranscribe } from "@/api/hooks"
import type { TranscribeResponse } from "@/types/api"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/utils"

export default function TranscribePage() {
  const { t } = useTranslation()
  const transcribe = useTranscribe()

  const [file, setFile] = React.useState<File | null>(null)
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<TranscribeResponse | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const [hotwords, setHotwords] = React.useState("")

  const audioRef = React.useRef<HTMLAudioElement | null>(null)

  const handleFile = (f: File | null) => {
    if (!f) return
    setFile(f)
    setResult(null)
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setAudioUrl(URL.createObjectURL(f))
  }

  const onSubmit = async () => {
    if (!file) return
    const data = (await transcribe.mutateAsync({
      file,
      language: "ar",
      detailed: true,
      hotwords: hotwords.trim() || undefined,
    })) as TranscribeResponse
    setResult(data)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith("audio/")) handleFile(f)
  }

  const seekTo = (sec: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = sec
      void audioRef.current.play()
    }
  }

  const speakerColors = ["text-primary", "text-orange-500", "text-emerald-600", "text-rose-500"]

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t("transcribe.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("transcribe.subtitle")}</p>
      </header>

      <div className="space-y-4 rounded-lg border bg-card p-4 sm:p-6">
        <Label>{t("transcribe.upload")}</Label>
        <label
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors",
            dragOver ? "border-primary bg-primary/5" : "border-border hover:bg-accent/30"
          )}
        >
          <Upload className="size-8 text-muted-foreground" />
          <span className="text-sm">{file?.name || t("transcribe.drop_here")}</span>
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />
        </label>

        {audioUrl && <audio ref={audioRef} src={audioUrl} controls className="w-full" />}

        <div className="space-y-2">
          <Label htmlFor="hotwords">{t("transcribe.hotwords")}</Label>
          <Input
            id="hotwords"
            dir="auto"
            value={hotwords}
            onChange={(e) => setHotwords(e.target.value)}
            placeholder={t("transcribe.hotwords_placeholder")}
          />
          <p className="text-xs text-muted-foreground">{t("transcribe.hotwords_hint")}</p>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={onSubmit} disabled={!file || transcribe.isPending}>
            {transcribe.isPending ? (
              <>
                <Loader2 className="me-2 size-4 animate-spin" />
                {t("transcribe.submitting")}
              </>
            ) : (
              t("transcribe.submit")
            )}
          </Button>
          {transcribe.error && (
            <span className="text-sm text-destructive">
              {(transcribe.error as Error).message}
            </span>
          )}
        </div>
      </div>

      {result && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label={t("transcribe.duration")} value={formatDuration(result.duration_s)} />
            <Stat
              label={t("transcribe.speakers")}
              value={String(result.speakers_count)}
              icon={<Users className="size-4 text-muted-foreground" />}
            />
            <Stat
              label={t("transcribe.generation_time")}
              value={`${(result.generation_ms / 1000).toFixed(1)}s`}
            />
          </div>

          <section className="rounded-lg border bg-card p-4 sm:p-6">
            <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
              {t("transcribe.result_text")}
            </h2>
            <p dir="auto" className="whitespace-pre-wrap text-base leading-relaxed">
              {result.text}
            </p>
          </section>

          <section className="rounded-lg border bg-card p-4 sm:p-6">
            <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
              {t("transcribe.result_segments")}
            </h2>
            <ol className="space-y-2">
              {result.segments.map((s, idx) => (
                <li
                  key={idx}
                  className="flex gap-3 rounded-md p-2 text-sm hover:bg-accent/40"
                >
                  <button
                    onClick={() => seekTo(s.start_time)}
                    className="shrink-0 tabular-nums text-muted-foreground hover:text-foreground"
                  >
                    {formatDuration(s.start_time)}
                  </button>
                  <span
                    className={cn(
                      "shrink-0 font-medium",
                      speakerColors[s.speaker_id % speakerColors.length]
                    )}
                  >
                    {t("transcribe.speaker", { id: s.speaker_id + 1 })}
                  </span>
                  <span dir="auto" className="flex-1">
                    {s.text}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-card p-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        {icon} {value}
      </span>
    </div>
  )
}
