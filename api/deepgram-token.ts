/**
 * Vercel serverless function — mints short-lived Deepgram project keys.
 *
 * Why a server function (not just sending the master key to the browser):
 *   - DEEPGRAM_API_KEY can mint unlimited tokens, change billing, and
 *     burn through every dollar in the project. Exposing it to the
 *     browser = pasting your credit card on the homepage.
 *   - Deepgram's recommended pattern: backend uses the master key to
 *     create a temporary project key with limited scope, then hands
 *     that to the browser. The browser opens the WebSocket directly,
 *     so audio doesn't round-trip through our backend.
 *
 * Env vars (set in Vercel project settings):
 *   DEEPGRAM_API_KEY      master key from console.deepgram.com
 *   DEEPGRAM_PROJECT_ID   project UUID — find at console.deepgram.com →
 *                         API Keys page, in the URL after /project/
 *   CORS_EXTRA_ORIGINS    comma-separated extra allow-list (optional)
 *
 * Request:
 *   POST /api/deepgram-token
 *   GET  /api/deepgram-token        (same — no body needed)
 *
 * Response:
 *   { api_key, api_key_id, expires_in }
 *
 * Lifetime: 30 minutes — long enough for any reasonable single voice
 * call, short enough that a leaked key is mostly worthless. Each call
 * to /calls fetches a fresh one.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node"

const DEFAULT_ORIGINS = [
  "https://voice-moshaar-frontend.vercel.app",
  "https://appassets.androidplatform.net",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4173",
]

function resolveAllowedOrigins(): Set<string> {
  const extra = (process.env.CORS_EXTRA_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return new Set([...DEFAULT_ORIGINS, ...extra])
}

function applyCors(req: VercelRequest, res: VercelResponse) {
  const origin = String(req.headers.origin ?? "")
  if (!origin) return
  const allowed = resolveAllowedOrigins()
  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With",
    )
    res.setHeader("Access-Control-Max-Age", "86400")
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  applyCors(req, res)

  if (req.method === "OPTIONS") {
    return res.status(204).end()
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS")
    return res.status(405).json({ error: "method not allowed" })
  }

  const masterKey = process.env.DEEPGRAM_API_KEY
  const projectId = process.env.DEEPGRAM_PROJECT_ID

  if (!masterKey || !projectId) {
    return res.status(500).json({
      error:
        "Deepgram is not configured. Set DEEPGRAM_API_KEY and " +
        "DEEPGRAM_PROJECT_ID in Vercel project env vars.",
    })
  }

  try {
    // Spawn a temporary project key, scope-limited and 30 min TTL. The
    // member scope is what the Voice Agent WebSocket requires — it gives
    // *only* "speak to the agent endpoint", not "mint more keys" or
    // "read billing". A leaked key can use voice minutes against this
    // project but can't escalate.
    const resp = await fetch(
      `https://api.deepgram.com/v1/projects/${projectId}/keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${masterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: `voice-moshaar-frontend session ${Date.now()}`,
          scopes: ["member"],
          time_to_live_in_seconds: 1800,
        }),
      },
    )

    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      return res.status(resp.status).json({
        error: `Deepgram key creation failed (${resp.status}): ${body || resp.statusText}`,
      })
    }

    const data = (await resp.json()) as {
      api_key?: string
      key?: string
      api_key_id?: string
    }

    // Deepgram has shipped both `api_key` and `key` in the response shape
    // historically — accept either so we don't break if they flip again.
    const apiKey = data.api_key ?? data.key

    if (!apiKey) {
      return res.status(502).json({
        error: "Deepgram returned no api_key in response",
      })
    }

    res.setHeader("Cache-Control", "no-store")
    return res.status(200).json({
      api_key: apiKey,
      api_key_id: data.api_key_id ?? null,
      expires_in: 1800,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return res.status(500).json({ error: `temp key error: ${msg}` })
  }
}
