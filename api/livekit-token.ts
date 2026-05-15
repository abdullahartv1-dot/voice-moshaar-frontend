/**
 * Vercel serverless function — mints short-lived LiveKit JWTs.
 *
 * Why a server function (and not generating the JWT in the browser):
 *   - LIVEKIT_API_SECRET must NEVER touch the client. With it any
 *     attacker can mint tokens for any room and impersonate any user.
 *   - The function is single-purpose: takes a user identity, returns
 *     {token, url, roomName}. No DB lookups, no auth gating yet — we
 *     add per-user gating once Moshaar NestJS issues identity tokens.
 *
 * Agent dispatch: our LiveKit Cloud agent (Kai-197b) declares
 * `agent_name="Kai-197b"` in its rtc_session decorator, which puts it
 * in **explicit dispatch mode** — it does NOT auto-join new rooms.
 * So we attach a RoomAgentDispatch to the access token so LiveKit
 * spawns the agent worker into the room the moment the user joins.
 * Without this the call goes silent: connection succeeds, mic streams
 * fine, but nothing comes back because no agent ever joined.
 *
 * Env vars (set in Vercel project settings):
 *   LIVEKIT_URL         wss://xxx.livekit.cloud
 *   LIVEKIT_API_KEY     APIxxxxxxxxxxxx
 *   LIVEKIT_API_SECRET  long base64-ish secret
 *   LIVEKIT_AGENT_NAME  defaults to "Kai-197b"
 *   CORS_EXTRA_ORIGINS  comma-separated list (e.g. "https://app1.com,https://app2.com")
 *                       — only the values listed are accepted in addition to
 *                       the defaults below; never use `*` here, the endpoint
 *                       mints LiveKit tokens that cost money per session.
 *
 * Request:
 *   POST /api/livekit-token   body: { user_id?, user_name?, mcp_url?, mcp_key? }
 *   GET  /api/livekit-token?user_id=...
 *
 * Response:
 *   { token, url, roomName, identity }
 *
 * CORS: This endpoint mints tokens that cost LiveKit minutes per call,
 *   so we keep an allow-list (NOT `*`). Defaults: the Vercel frontend
 *   itself, the standard Android WebViewAssetLoader origin used by our
 *   mobile app, and localhost for dev. Add more via CORS_EXTRA_ORIGINS.
 *   This is NOT a real security boundary — anyone with curl bypasses it
 *   trivially. The real protection (TODO) is verifying a Moshaar identity
 *   token issued by the NestJS backend.
 *
 * Room naming: `mkalama-<sanitized-user-id>-<timestamp36>` so concurrent
 * sessions don't share an agent. LiveKit Agent Builder dispatches one
 * agent worker per room when a participant joins.
 *
 * MCP forwarding: per-user MCP credentials are attached to the access
 * token as participant metadata, so a future custom Python agent worker
 * can read them off the room. The current Agent Builder agent uses the
 * static MCP config from its Actions tab and ignores this metadata —
 * harmless for now.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node"
import { AccessToken } from "livekit-server-sdk"
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol"

// Default allow-list. We keep these in code (not env) so the mobile app
// keeps working even if the Vercel env vars are wiped by accident.
const DEFAULT_ORIGINS = [
  "https://voice-moshaar-frontend.vercel.app",
  // Standard origin used by Android WebViewAssetLoader — fixed by Google,
  // every hybrid Android app that loads local assets via WebViewAssetLoader
  // sees this as window.location.origin. Cannot be changed by the app.
  "https://appassets.androidplatform.net",
  // iOS hybrid apps using WKWebView with loadFileURL show up as "null" or
  // a custom scheme — we handle that lower down (no Origin header at all,
  // which is normal for native HTTP libraries on mobile).
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
  const allowed = resolveAllowedOrigins()

  // No Origin header at all → request is from a non-browser client
  // (native mobile HTTP lib, curl, server-to-server). The browser would
  // always send one. Such requests aren't bound by CORS anyway, so we
  // skip setting the header — the response goes through normally.
  if (!origin) return

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With",
    )
    // Cache the preflight result for a day so the WebView doesn't
    // OPTIONS-spam us on every call.
    res.setHeader("Access-Control-Max-Age", "86400")
  }
  // If the Origin is set but NOT in the allow-list we deliberately omit
  // Access-Control-Allow-Origin — the browser will block the response.
  // We do NOT 403 here: that would leak which origins are allowed.
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  // Always set CORS headers first so even error responses are readable
  // by the calling page (browsers won't show error bodies otherwise).
  applyCors(req, res)

  // Preflight: the browser sends OPTIONS before the real POST whenever
  // we have a non-simple request (Content-Type: application/json
  // qualifies). We answer 204 with the CORS headers already set above.
  if (req.method === "OPTIONS") {
    return res.status(204).end()
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS")
    return res.status(405).json({ error: "method not allowed" })
  }

  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  const wsUrl = process.env.LIVEKIT_URL

  if (!apiKey || !apiSecret || !wsUrl) {
    return res.status(500).json({
      error:
        "LiveKit credentials not configured. Set LIVEKIT_URL, " +
        "LIVEKIT_API_KEY, LIVEKIT_API_SECRET in Vercel project env vars.",
    })
  }

  const body =
    req.method === "POST"
      ? ((req.body ?? {}) as Record<string, unknown>)
      : {}

  const userId = String(
    body.user_id ??
      req.query.user_id ??
      `guest-${Math.random().toString(36).slice(2, 10)}`,
  )
  const userName = String(body.user_name ?? req.query.user_name ?? userId)
  const mcpUrl = String(body.mcp_url ?? req.query.mcp_url ?? "")
  const mcpKey = String(body.mcp_key ?? req.query.mcp_key ?? "")

  // LiveKit room names: alphanumeric + dashes + underscores only.
  const safeId = userId.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 40)
  const roomName = `mkalama-${safeId}-${Date.now().toString(36)}`

  const at = new AccessToken(apiKey, apiSecret, {
    identity: userId,
    name: userName,
    ttl: 15 * 60, // 15 minutes — plenty for one call session
  })
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })

  if (mcpUrl || mcpKey) {
    at.metadata = JSON.stringify({ mcp_url: mcpUrl, mcp_key: mcpKey })
  }

  // Dispatch the Arabic Sara agent into this room. Required because the
  // agent declares agent_name="Kai-197b" → explicit dispatch mode.
  const agentName = process.env.LIVEKIT_AGENT_NAME || "Kai-197b"
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName })],
  })

  const token = await at.toJwt()

  res.setHeader("Cache-Control", "no-store")
  return res
    .status(200)
    .json({ token, url: wsUrl, roomName, identity: userId })
}
