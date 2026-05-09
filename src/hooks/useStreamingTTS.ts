import * as React from "react"
import { startTTSStream } from "@/api/tts-ws"
import { createPCMPlayer, type PCMPlayer } from "@/lib/pcm-player"
import type { VoiceSettings } from "@/types/api"

/**
 * Streaming TTS player. Opens a WebSocket to /v1/text-to-speech/{voice_id}/ws
 * and pipes PCM16LE chunks into an AudioWorklet for sample-accurate gapless
 * playback — first audio usually starts <300 ms after the request.
 *
 * Returns:
 *   - speak(text, voiceId, settings?): start a new utterance (cancels current)
 *   - stop(): cancel and close
 *   - isPlaying, isLoading, ttfaMs, totalMs: live status for UI
 */
export interface SpeakOptions {
  /** When true, server runs the text through Qwen first to add Arabic
   * diacritics — fixes mispronunciations on bare text. Adds ~300-1500ms
   * before audio starts. */
  autoDiacritize?: boolean
}

export interface StreamingTTS {
  speak: (
    text: string,
    voiceId: string,
    settings?: VoiceSettings,
    opts?: SpeakOptions
  ) => Promise<void>
  stop: () => void
  isPlaying: boolean
  isLoading: boolean
  ttfaMs: number | null
  totalMs: number | null
  error: string | null
}

export function useStreamingTTS(): StreamingTTS {
  const playerRef = React.useRef<PCMPlayer | null>(null)
  const handleRef = React.useRef<{ close: () => void } | null>(null)
  const [isPlaying, setPlaying] = React.useState(false)
  const [isLoading, setLoading] = React.useState(false)
  const [ttfaMs, setTtfa] = React.useState<number | null>(null)
  const [totalMs, setTotal] = React.useState<number | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const ensurePlayer = React.useCallback(async () => {
    if (!playerRef.current) {
      playerRef.current = await createPCMPlayer()
    }
    return playerRef.current
  }, [])

  const stop = React.useCallback(() => {
    handleRef.current?.close()
    handleRef.current = null
    playerRef.current?.reset()
    setPlaying(false)
    setLoading(false)
  }, [])

  const speak = React.useCallback(
    async (text: string, voiceId: string, settings?: VoiceSettings, opts?: SpeakOptions) => {
      stop()
      const player = await ensurePlayer()
      player.reset()
      setError(null)
      setTtfa(null)
      setTotal(null)
      setLoading(true)

      handleRef.current = startTTSStream(
        voiceId,
        text,
        {
          onTtfa: (ms) => {
            setTtfa(ms)
            setLoading(false)
            setPlaying(true)
          },
          onChunk: (buf) => {
            player.pushPCM16LE(buf)
          },
          onDone: (info) => {
            setTotal(info.total_wall_ms)
            player.flush()
            // Wait for the worklet to drain its queue before flipping state
            void player.waitForDrain().then(() => setPlaying(false))
          },
          onError: (msg) => {
            setError(msg)
            setLoading(false)
            setPlaying(false)
          },
        },
        settings,
        opts?.autoDiacritize ?? false,
      )
    },
    [ensurePlayer, stop]
  )

  React.useEffect(() => {
    return () => {
      stop()
      void playerRef.current?.close()
      playerRef.current = null
    }
  }, [stop])

  return { speak, stop, isPlaying, isLoading, ttfaMs, totalMs, error }
}
