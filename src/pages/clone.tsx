import * as React from "react"
import { useNavigate } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Loader2, Upload, CheckCircle2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { useCloneVoice } from "@/api/hooks"
import { cn } from "@/lib/utils"

const cloneSchema = z.object({
  name: z.string().min(2, "name_min").max(80),
  language: z.enum(["ar", "en", "multi"]),
})

type CloneForm = z.infer<typeof cloneSchema>

export default function ClonePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const cloneMutation = useCloneVoice()

  const [file, setFile] = React.useState<File | null>(null)
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null)
  const [duration, setDuration] = React.useState(0)
  const [region, setRegion] = React.useState<[number, number]>([0, 20])
  const [success, setSuccess] = React.useState<string | null>(null)
  const [dragOver, setDragOver] = React.useState(false)

  const audioRef = React.useRef<HTMLAudioElement | null>(null)

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<CloneForm>({
    resolver: zodResolver(cloneSchema),
    defaultValues: { name: "", language: "ar" },
  })

  const handleFile = (f: File | null) => {
    if (!f) return
    setFile(f)
    setSuccess(null)
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    const url = URL.createObjectURL(f)
    setAudioUrl(url)
  }

  // When the audio loads, capture its duration and seed the region.
  React.useEffect(() => {
    if (!audioUrl) return
    const a = new Audio(audioUrl)
    a.addEventListener("loadedmetadata", () => {
      const d = a.duration || 0
      setDuration(d)
      setRegion([0, Math.min(20, Math.max(3, d))])
    })
    audioRef.current = a
  }, [audioUrl])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith("audio/")) handleFile(f)
  }

  const onSubmit = async (form: CloneForm) => {
    if (!file) return
    const [start, end] = region
    const res = await cloneMutation.mutateAsync({
      name: form.name,
      language: form.language,
      start_s: start,
      end_s: end,
      file,
    })
    setSuccess(res.voice_id)
    setTimeout(() => navigate("/library"), 1200)
  }

  const regionDur = region[1] - region[0]
  const durationOK = regionDur >= 3 && regionDur <= 30

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t("clone.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("clone.subtitle")}</p>
      </header>

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="space-y-6 rounded-lg border bg-card p-4 sm:p-6"
      >
        <div className="space-y-2">
          <Label htmlFor="voice-name">{t("clone.name")}</Label>
          <Input
            id="voice-name"
            dir="auto"
            placeholder={t("clone.name_placeholder")}
            {...register("name")}
          />
          {errors.name && (
            <p className="text-sm text-destructive">
              {t(`clone.errors.${errors.name.message ?? "name_required"}`)}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label>{t("clone.language")}</Label>
          <Controller
            control={control}
            name="language"
            render={({ field }) => (
              <div className="flex gap-2">
                {(["ar", "en", "multi"] as const).map((lang) => (
                  <button
                    type="button"
                    key={lang}
                    onClick={() => field.onChange(lang)}
                    className={cn(
                      "rounded-md border px-4 py-1.5 text-sm transition-colors",
                      field.value === lang
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-input hover:bg-accent"
                    )}
                  >
                    {t(`clone.language_${lang}`)}
                  </button>
                ))}
              </div>
            )}
          />
        </div>

        <div className="space-y-2">
          <Label>{t("clone.upload")}</Label>
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
            <span className="text-sm">{file?.name || t("clone.drop_here")}</span>
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        {audioUrl && duration > 0 && (
          <div className="space-y-3 rounded-md border bg-background p-4">
            <div className="flex items-center justify-between">
              <Label>{t("clone.trim_region")}</Label>
              <span className="text-sm tabular-nums text-muted-foreground">
                {regionDur.toFixed(1)}s ({region[0].toFixed(1)} → {region[1].toFixed(1)})
              </span>
            </div>
            <Slider
              min={0}
              max={duration}
              step={0.1}
              value={region}
              onValueChange={(vals) => {
                if (vals.length === 2 && vals[0] !== undefined && vals[1] !== undefined) {
                  setRegion([vals[0], vals[1]])
                }
              }}
            />
            <audio
              src={audioUrl}
              controls
              className="w-full"
              onPlay={(e) => {
                e.currentTarget.currentTime = region[0]
              }}
              onTimeUpdate={(e) => {
                if (e.currentTarget.currentTime > region[1]) {
                  e.currentTarget.pause()
                }
              }}
            />
            {!durationOK && (
              <p className="text-sm text-destructive">
                {regionDur < 3 ? t("clone.errors.duration_min") : t("clone.errors.duration_max")}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={!file || !durationOK || cloneMutation.isPending}
            className="min-w-[140px]"
          >
            {cloneMutation.isPending ? (
              <>
                <Loader2 className="me-2 size-4 animate-spin" />
                {t("clone.submitting")}
              </>
            ) : (
              t("clone.submit")
            )}
          </Button>
          {success && (
            <span className="flex items-center gap-1.5 text-sm text-primary">
              <CheckCircle2 className="size-4" /> {t("clone.success")}
            </span>
          )}
          {cloneMutation.error && (
            <span className="text-sm text-destructive">
              {(cloneMutation.error as Error).message}
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
