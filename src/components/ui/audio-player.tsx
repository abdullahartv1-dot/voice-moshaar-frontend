import * as React from "react"

/**
 * Single-source-of-truth HTMLAudioElement wrapper. Only one item plays at a
 * time across the app — picking a different item pauses the current one.
 *
 * Used by VoicePicker for previewing voices, and by the library page for
 * playing generated TTS output.
 */
export interface AudioItem {
  id: string
  src: string
}

interface AudioPlayerCtx {
  activeId: string | null
  isPlaying: boolean
  isLoading: boolean
  currentTime: number
  duration: number
  play: (item: AudioItem) => void
  pause: () => void
  stop: () => void
  isItemActive: (id: string) => boolean
  seek: (time: number) => void
}

const Ctx = React.createContext<AudioPlayerCtx | null>(null)

export function AudioPlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [isPlaying, setPlaying] = React.useState(false)
  const [isLoading, setLoading] = React.useState(false)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [duration, setDuration] = React.useState(0)

  const ensureAudio = React.useCallback(() => {
    if (audioRef.current) return audioRef.current
    const a = new Audio()
    a.preload = "auto"
    a.crossOrigin = "anonymous"
    a.addEventListener("playing", () => {
      setPlaying(true)
      setLoading(false)
    })
    a.addEventListener("pause", () => setPlaying(false))
    a.addEventListener("ended", () => {
      setPlaying(false)
      setActiveId(null)
    })
    a.addEventListener("waiting", () => setLoading(true))
    a.addEventListener("loadedmetadata", () => setDuration(a.duration || 0))
    a.addEventListener("timeupdate", () => setCurrentTime(a.currentTime || 0))
    a.addEventListener("error", () => {
      setLoading(false)
      setPlaying(false)
    })
    audioRef.current = a
    return a
  }, [])

  const play = React.useCallback(
    (item: AudioItem) => {
      const a = ensureAudio()
      if (a.src !== item.src) {
        a.src = item.src
        setLoading(true)
        setCurrentTime(0)
        setDuration(0)
      }
      setActiveId(item.id)
      void a.play().catch(() => setLoading(false))
    },
    [ensureAudio]
  )

  const pause = React.useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const stop = React.useCallback(() => {
    if (!audioRef.current) return
    audioRef.current.pause()
    audioRef.current.currentTime = 0
    setActiveId(null)
  }, [])

  const seek = React.useCallback((t: number) => {
    if (audioRef.current) audioRef.current.currentTime = t
  }, [])

  const isItemActive = React.useCallback((id: string) => activeId === id, [activeId])

  const value = React.useMemo<AudioPlayerCtx>(
    () => ({
      activeId,
      isPlaying,
      isLoading,
      currentTime,
      duration,
      play,
      pause,
      stop,
      isItemActive,
      seek,
    }),
    [activeId, isPlaying, isLoading, currentTime, duration, play, pause, stop, isItemActive, seek]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAudioPlayer(): AudioPlayerCtx {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useAudioPlayer must be used within <AudioPlayerProvider>")
  return ctx
}
