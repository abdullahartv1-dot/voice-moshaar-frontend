import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

/** Currently selected voice for the library/TTS page. */
export const selectedVoiceAtom = atomWithStorage<string | null>("mv-selected-voice", null)

/** Theme preference. `system` follows OS. */
export type Theme = "light" | "dark" | "system"
export const themeAtom = atomWithStorage<Theme>("mv-theme", "system")

/** Active audio item id (used by AudioPlayerProvider to single-source playback). */
export const activeAudioIdAtom = atom<string | null>(null)
export const audioPlayingAtom = atom(false)
