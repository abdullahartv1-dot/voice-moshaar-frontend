import axios, { type AxiosInstance } from "axios"

/**
 * Axios instance for the Mostashar Voice API.
 *
 * Auth: sends `xi-api-key` header from VITE_API_KEY env. When unset (dev),
 * the backend may be running with auth disabled.
 *
 * Base URL: empty by default (uses Vite's dev proxy on /v1). For prod builds
 * set VITE_BACKEND_URL to an absolute origin (e.g. https://voice.example.com).
 */
const baseURL: string = import.meta.env.VITE_BACKEND_URL || ""
const apiKey: string = import.meta.env.VITE_API_KEY || ""

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
