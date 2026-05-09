import * as React from "react"
import { useTranslation } from "react-i18next"
import { Check, ChevronsUpDown, Pause, Play } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  AudioPlayerProvider,
  useAudioPlayer,
} from "@/components/ui/audio-player"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Orb } from "@/components/ui/orb"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DIALECT_LABELS,
  dialectFromVoiceId,
  type Voice,
} from "@/types/api"

interface VoicePickerProps {
  voices: Voice[]
  value?: string | null
  onValueChange?: (voiceId: string) => void
  placeholder?: string
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * Voice picker — combobox + previewable Orb avatars. Adapted from the
 * shadcn-style component to use the native Mostashar API shape (no
 * @elevenlabs/elevenlabs-js dependency).
 */
function VoicePicker({
  voices,
  value,
  onValueChange,
  placeholder,
  className,
  open,
  onOpenChange,
}: VoicePickerProps) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = React.useState(false)
  const isControlled = open !== undefined
  const isOpen = isControlled ? open : internalOpen
  const setIsOpen = (v: boolean) => {
    if (isControlled) onOpenChange?.(v)
    else setInternalOpen(v)
  }

  const selectedVoice = voices.find((v) => v.voice_id === value)

  return (
    <AudioPlayerProvider>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={isOpen}
            className={cn("w-full justify-between", className)}
          >
            {selectedVoice ? (
              <div className="flex items-center gap-2 overflow-hidden">
                <div className="relative size-6 shrink-0 overflow-visible">
                  <Orb agentState="thinking" className="absolute inset-0" />
                </div>
                <span className="truncate">{selectedVoice.name}</span>
              </div>
            ) : (
              <span className="text-muted-foreground">
                {placeholder ?? t("library.select_voice")}
              </span>
            )}
            <ChevronsUpDown className="ms-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] p-0"
          align="start"
        >
          <Command>
            <CommandInput placeholder={t("library.search")} />
            <CommandList>
              <CommandEmpty>{t("library.no_voice")}</CommandEmpty>
              <CommandGroup>
                {voices.map((voice) => (
                  <VoicePickerItem
                    key={voice.voice_id}
                    voice={voice}
                    isSelected={value === voice.voice_id}
                    onSelect={() => {
                      onValueChange?.(voice.voice_id)
                    }}
                  />
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </AudioPlayerProvider>
  )
}

interface VoicePickerItemProps {
  voice: Voice
  isSelected: boolean
  onSelect: () => void
}

function VoicePickerItem({ voice, isSelected, onSelect }: VoicePickerItemProps) {
  const { i18n } = useTranslation()
  const [isHovered, setHovered] = React.useState(false)
  const player = useAudioPlayer()

  const previewSrc = voice.preview_url
  const audioItem = React.useMemo(
    () => (previewSrc ? { id: voice.voice_id, src: previewSrc } : null),
    [previewSrc, voice.voice_id]
  )

  const isPlaying =
    audioItem !== null && player.isItemActive(audioItem.id) && player.isPlaying

  const handlePreview = React.useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!audioItem) return
      if (isPlaying) player.pause()
      else player.play(audioItem)
    },
    [audioItem, isPlaying, player]
  )

  const dialect = dialectFromVoiceId(voice.voice_id)
  const dialectLabel =
    dialect &&
    DIALECT_LABELS[dialect][i18n.language === "en" ? "en" : "ar"]

  return (
    <CommandItem
      value={`${voice.voice_id} ${voice.name}`}
      onSelect={onSelect}
      className="flex items-center gap-3"
    >
      <div
        role="button"
        tabIndex={-1}
        className="relative z-10 size-8 shrink-0 cursor-pointer overflow-visible"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={handlePreview}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") handlePreview(e)
        }}
      >
        <Orb
          agentState={isPlaying ? "talking" : "idle"}
          className="pointer-events-none absolute inset-0"
        />
        {previewSrc && isHovered && (
          <div className="pointer-events-none absolute inset-0 flex size-8 shrink-0 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm transition-opacity">
            {isPlaying ? (
              <Pause className="size-3 text-white" />
            ) : (
              <Play className="size-3 text-white" />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <span className="font-medium truncate">{voice.name}</span>
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {dialectLabel && <span>{dialectLabel}</span>}
          {dialectLabel && voice.dur_s ? <span>•</span> : null}
          {voice.dur_s ? <span>{voice.dur_s.toFixed(1)}s</span> : null}
        </div>
      </div>

      <Check
        className={cn(
          "ms-auto size-4 shrink-0",
          isSelected ? "opacity-100" : "opacity-0"
        )}
      />
    </CommandItem>
  )
}

export { VoicePicker, VoicePickerItem }
