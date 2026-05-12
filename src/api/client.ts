import axios, { type AxiosInstance } from "axios"

/**
 * Axios instance for the Mostashar Voice API.
 *
 * Resolution order:
 *   1. VITE_BACKEND_URL env (build-time; Vercel project settings)
 *   2. Hard-coded Cloudflare tunnel fallback (only used when env is empty)
 *   3. Empty string (Vite dev proxy on /v1)
 *
 * The fallback exists because Vercel's "Sensitive" env vars are not
 * available at build time, so production builds may end up with an
 * empty VITE_BACKEND_URL even when the variable is configured.  Having
 * a baked-in default URL makes the production site work out-of-box
 * for the live testing pod.
 */
const PROD_FALLBACK_BACKEND =
  typeof window !== "undefined" && window.location.hostname.endsWith(".vercel.app")
    ? "https://gene-prev-precision-ethics.trycloudflare.com"
    : ""
const baseURL: string =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) || PROD_FALLBACK_BACKEND
const apiKey: string =
  (import.meta.env.VITE_API_KEY as string | undefined) ||
  (typeof window !== "undefined" && window.location.hostname.endsWith(".vercel.app")
    ? "mostashar-dev-key"
    : "")

export const api: AxiosInstance = axios.create({
  baseURL,
  timeout: 60_000,
  headers: apiKey ? { "xi-api-key": apiKey } : {},
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err?.response?.status
    const detail = err?.response?.data?.detail || err?.response?.data || err.message
    return Promise.reject(
      Object.assign(new Error(typeof detail === "string" ? detail : JSON.stringify(detail)), {
        status,
        cause: err,
      })
    )
  }
)

export const API_KEY = apiKey
export const BACKEND_URL = baseURL
