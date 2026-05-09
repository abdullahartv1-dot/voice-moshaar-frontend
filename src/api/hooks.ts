import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "./client"
import type {
  CloneResponse,
  HealthResponse,
  ModelInfo,
  STTResponse,
  TTSRequest,
  TranscribeResponse,
  Voice,
  VoiceSettings,
  VoicesListResponse,
} from "@/types/api"

export const qk = {
  health: ["health"] as const,
  models: ["models"] as const,
  voices: ["voices"] as const,
  voice: (id: string) => ["voices", id] as const,
}

export function useHealth() {
  return useQuery({
    queryKey: qk.health,
    queryFn: async () => (await api.get<HealthResponse>("/v1/health")).data,
    staleTime: 30_000,
  })
}

export function useModels() {
  return useQuery({
    queryKey: qk.models,
    queryFn: async () => (await api.get<ModelInfo[]>("/v1/models")).data,
    staleTime: 5 * 60_000,
  })
}

export function useVoices() {
  return useQuery({
    queryKey: qk.voices,
    queryFn: async () => (await api.get<VoicesListResponse>("/v1/voices")).data.voices,
    staleTime: 30_000,
  })
}

export interface CloneVoiceInput {
  name: string
  language: "ar" | "en" | "multi"
  start_s: number
  end_s: number
  file: File
}

export function useCloneVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CloneVoiceInput): Promise<CloneResponse> => {
      const fd = new FormData()
      fd.append("name", input.name)
      fd.append("language", input.language)
      fd.append("start_s", String(input.start_s))
      fd.append("end_s", String(input.end_s))
      fd.append("files", input.file)
      const res = await api.post<CloneResponse>("/v1/voices/add", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.voices })
    },
  })
}

export function useDeleteVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (voice_id: string) => {
      await api.delete(`/v1/voices/${encodeURIComponent(voice_id)}`)
      return voice_id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.voices })
    },
  })
}

/**
 * Generate full TTS audio (non-streaming). Returns a Blob (audio/wav).
 * For streaming use the WebSocket directly.
 */
export async function ttsFull(voiceId: string, req: TTSRequest): Promise<Blob> {
  const res = await api.post(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, req, {
    responseType: "blob",
  })
  return res.data
}

export function useTTS() {
  return useMutation({
    mutationFn: ({ voiceId, req }: { voiceId: string; req: TTSRequest }) =>
      ttsFull(voiceId, req),
  })
}

export interface DialogueLineInput {
  speaker: number
  text: string
}

export interface DialogueRequestInput {
  speakers: string[]
  lines: DialogueLineInput[]
  voice_settings?: VoiceSettings
}

export function useDialogue() {
  return useMutation({
    mutationFn: async (req: DialogueRequestInput): Promise<Blob> => {
      const res = await api.post("/v1/dialogue", { ...req, output_format: "wav" }, {
        responseType: "blob",
      })
      return res.data
    },
  })
}

export interface TranscribeInput {
  file: File | Blob
  language?: string
  detailed?: boolean
  /** Comma-separated domain names/terms to bias recognition (e.g. "أرامكو, STC, Kubernetes"). */
  hotwords?: string
}

/** Speech-to-text. Returns plain text by default; pass `detailed=true` for segments + diarization. */
export function useTranscribe() {
  return useMutation({
    mutationFn: async ({
      file,
      language = "ar",
      detailed = false,
      hotwords,
    }: TranscribeInput) => {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("language", language)
      if (hotwords && hotwords.trim()) fd.append("hotwords", hotwords.trim())
      const path = detailed ? "/v1/transcribe" : "/v1/speech-to-text"
      const res = await api.post<STTResponse | TranscribeResponse>(path, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      return res.data
    },
  })
}

export type { Voice }
