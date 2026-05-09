import i18n from "i18next"
import LanguageDetector from "i18next-browser-languagedetector"
import { initReactI18next } from "react-i18next"
import ar from "./ar.json"
import en from "./en.json"

const SUPPORTED = ["ar", "en"] as const
export type SupportedLang = (typeof SUPPORTED)[number]
export const RTL_LANGS: ReadonlyArray<SupportedLang> = ["ar"]

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      ar: { translation: ar },
      en: { translation: en },
    },
    fallbackLng: "ar",
    supportedLngs: [...SUPPORTED],
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  })

export function applyLangToDocument(lng: string) {
  const safe = (SUPPORTED as readonly string[]).includes(lng) ? (lng as SupportedLang) : "ar"
  document.documentElement.lang = safe
  document.documentElement.dir = (RTL_LANGS as readonly string[]).includes(safe) ? "rtl" : "ltr"
}

i18n.on("languageChanged", applyLangToDocument)
applyLangToDocument(i18n.language || "ar")

export default i18n
