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
 *
 * Request:
 *   POST /api/livekit-token   body: { user_id?, user_name?, mcp_url?, mcp_key? }
 *   GET  /api/livekit-token?user_id=...
 *
 * Response:
 *   { token, url, roomName, identity }
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

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST")
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
