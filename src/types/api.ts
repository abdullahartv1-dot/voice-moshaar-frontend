/**
 * Types mirroring the Mostashar Voice REST API (v1).
 * Source: vibevoice_streaming/server_v5_api.py
 */

export interface Voice {
  voice_id: string
  name: string
  language: string
  dur_s: number
  preview_url: string
  created_at: number | null
}

export interface VoicesListResponse {
  voices: Voice[]
}

/** Spectral metrics for a single audio file — used by the clone-page
 *  before/after panel to show the user what changed when their upload
 *  went through OpenVoice tone-color enhancement. */
export interface SpectralMetrics {
  duration_s?: number
  peak?: number
  spectral_flatness?: number
  sib_to_speech?: number
  hf_to_speech?: number
}

export interface CloneEnhancementMetrics {
  donor?: SpectralMetrics
  target?: SpectralMetrics
  enhanced?: SpectralMetrics
}

export interface CloneEnhancement {
  donor_id: string
  gen_ms: number
  metrics?: CloneEnhancementMetrics
}

export interface CloneResponse {
  voice_id: string
  name: string
  language: string
  dur_s: number
  /** True ⇔ on-disk reference went through OpenVoice clarity transfer.
   *  False usually means the sidecar is disabled or unreachable; the
   *  clone still works (using the raw upload), just without the
   *  articulation-clarity boost. */
  enhanced?: boolean
  enhancement?: CloneEnhancement | null
}

export interface VoiceSettings {
  cfg_scale?: number
  diffusion_steps?: number
  seed?: number
}

export interface TTSRequest {
  text: string
  voice_settings?: VoiceSettings
  output_format?: "pcm_24000" | "wav"
}

export interface TranscriptSegment {
  start_time: number
  end_time: number
  speaker_id: number
  text: string
}

export interface STTResponse {
  text: string
  language: string
  duration_s: number
}

export interface TranscribeResponse extends STTResponse {
  speakers_count: number
  segments: TranscriptSegment[]
  generation_ms: number
}

export interface HealthResponse {
  status: string
  model: string
  diffusion_steps: number
  voices_count: number
  gpu_mem_gb: number
  version: string
  asr_loaded: boolean
  asr_model: string | null
  whisper_loaded?: boolean
  whisper_model?: string | null
  /** Voice-agent LLM driver: "gemma" (local sidecar) or "openai" (gpt-4o-mini). */
  llm_backend?: "gemma" | "openai"
  /** True when MV_OPENAI_KEY env var is set on the pod. */
  openai_key_configured?: boolean
}

export interface ModelInfo {
  model_id: string
  name: string
  languages: string[]
  can_clone: boolean
  description: string
}

/**
 * Optional client-side enrichment shown in the picker UI. The server returns
 * voice_id like "hamed_saudi" and name like "حامد - سعودي"; this maps the
 * suffix to a dialect tag for nicer rendering. Falls back gracefully.
 */
export const DIALECT_LABELS: Record<string, { ar: string; en: string }> = {
  saudi: { ar: "سعودي", en: "Saudi" },
  egypt: { ar: "مصري", en: "Egyptian" },
  lebanon: { ar: "لبناني", en: "Lebanese" },
  uae: { ar: "إماراتي", en: "Emirati" },
  kuwait: { ar: "كويتي", en: "Kuwaiti" },
}

export function dialectFromVoiceId(voiceId: string): keyof typeof DIALECT_LABELS | null {
  const parts = voiceId.split("_")
  const last = parts[parts.length - 1]
  if (last && last in DIALECT_LABELS) return last as keyof typeof DIALECT_LABELS
  return null
}
