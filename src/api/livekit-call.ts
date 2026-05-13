/**
 * LiveKitCall — thin wrapper around the livekit-client SDK that exposes
 * the same shape as the old RealtimeClient so /calls page barely changes.
 *
 * Why we don't speak the LiveKit Room API directly from calls.tsx:
 *   - We want one place to map LiveKit events → our "listening / thinking
 *     / speaking" state machine (the LiveCallOrb already understands).
 *   - We can swap from Agent Builder to a custom Python worker later
 *     without touching the UI.
 *
 * Pipeline (everything happens server-side on LiveKit Cloud):
 *   Browser mic → LiveKit room → Agent worker
 *     → Deepgram Nova-3 (STT)
 *     → OpenAI gpt-5.2-chat (LLM, with MCP tools from Moshaar)
 *     → Cartesia / ElevenLabs (TTS)
 *   → audio track back to the browser, auto-played.
 *
 * Transcripts and agent state are surfaced as:
 *   - RoomEvent.TranscriptionReceived  → user + assistant text segments
 *   - participant attribute "lk.agent.state" → "listening" | "thinking" | "speaking"
 *
 * Mic level for the orb: livekit-client exposes `localParticipant.audioLevel`
 * (0..1) which is good enough for visual feedback. We poll at 10 Hz.
 */
import {
  ConnectionState,
  LocalParticipant,
  Participant,
  RemoteParticipant,
  Room,
  RoomEvent,
  type TrackPublication,
  type TranscriptionSegment,
} from "livekit-client"

export type RealtimeState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"

export interface RealtimeTurn {
  role: "user" | "assistant"
  text: string
  ts: number
  /** True while a transcription segment is still streaming. */
  partial?: boolean
}

export interface LiveKitCallbacks {
  onState?: (s: RealtimeState) => void
  onUserTranscript?: (text: string, final: boolean) => void
  onAssistantTranscript?: (text: string, final: boolean) => void
  onMicLevel?: (rms: number) => void
  onError?: (msg: string) => void
}

export interface LiveKitConnectOptions {
  userId?: string
  userName?: string
  /** Forwarded to the agent via room metadata (for future custom worker). */
  mcpUrl?: string
  mcpKey?: string
}

interface TokenResponse {
  token: string
  url: string
  roomName: string
  identity: string
}

/**
 * Path of the Vercel serverless function that mints LiveKit JWTs.
 * Same-origin so no CORS hop. Override via VITE_LIVEKIT_TOKEN_URL if you
 * want to point at a different backend (e.g. NestJS at rebuild-api).
 */
const TOKEN_ENDPOINT =
  (import.meta.env.VITE_LIVEKIT_TOKEN_URL as string | undefined) ||
  "/api/livekit-token"

export class LiveKitCall {
  private room: Room | null = null
  private cbs: LiveKitCallbacks
  private state: RealtimeState = "idle"
  private micPollHandle: number | null = null
  private closedByCaller = false

  constructor(cbs: LiveKitCallbacks) {
    this.cbs = cbs
  }

  private setState(s: RealtimeState) {
    if (this.state === s) return
    this.state = s
    this.cbs.onState?.(s)
  }

  async connect(opts: LiveKitConnectOptions = {}): Promise<void> {
    this.setState("connecting")

    // 1) Fetch a short-lived JWT from our Vercel function.
    const tokenResp = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: opts.userId,
        user_name: opts.userName,
        mcp_url: opts.mcpUrl,
        mcp_key: opts.mcpKey,
      }),
    })
    if (!tokenResp.ok) {
      const body = await tokenResp.text().catch(() => "")
      throw new Error(
        `token fetch failed (${tokenResp.status}): ${body || tokenResp.statusText}`,
      )
    }
    const { token, url } = (await tokenResp.json()) as TokenResponse

    // 2) Configure room: AGC + noise suppression + echo cancellation on,
    //    adaptive stream so we don't waste bandwidth on a single-audio call.
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      publishDefaults: {
        // PCM16 24 kHz mono via Opus — LiveKit handles the encoding.
        audioPreset: { maxBitrate: 32_000 },
      },
    })

    this.attachRoomListeners(room)

    await room.connect(url, token, { autoSubscribe: true })

    // 3) Publish mic. LiveKit Agent Builder's worker will join the room
    //    on its own (auto-dispatch) once we're connected.
    await room.localParticipant.setMicrophoneEnabled(true)

    this.room = room
    this.setState("listening")

    this.startMicMetering()
  }

  private attachRoomListeners(room: Room) {
    // Agent state → our state machine. Agent Builder publishes its current
    // state as a participant attribute.
    room.on(
      RoomEvent.ParticipantAttributesChanged,
      (changed: Record<string, string>, participant: Participant) => {
        if (participant.isLocal) return
        const next = changed["lk.agent.state"]
        if (next) this.mapAgentState(next)
      },
    )

    // Same info, but for participants that joined with the attribute
    // already set (we missed the first change event).
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      const cur = p.attributes?.["lk.agent.state"]
      if (cur) this.mapAgentState(cur)
    })

    // Transcripts. `segment.final` distinguishes streaming partials from
    // committed text. We forward both so the UI can show a typing dot.
    room.on(
      RoomEvent.TranscriptionReceived,
      (
        segments: TranscriptionSegment[],
        participant?: Participant,
        _publication?: TrackPublication,
      ) => {
        const fromAgent = !!participant && !participant.isLocal
        for (const seg of segments) {
          if (fromAgent) {
            this.cbs.onAssistantTranscript?.(seg.text, !!seg.final)
          } else {
            this.cbs.onUserTranscript?.(seg.text, !!seg.final)
          }
        }
      },
    )

    room.on(RoomEvent.Disconnected, () => {
      if (!this.closedByCaller) {
        // Network drop or kicked. Surface as a soft error so the UI can
        // show a reconnect button, without scaring the user with an
        // 1011-style code.
        this.cbs.onError?.("انقطع الاتصال — حاول من جديد.")
      }
      this.setState("idle")
    })

    room.on(RoomEvent.ConnectionStateChanged, (st: ConnectionState) => {
      if (st === ConnectionState.Connecting) this.setState("connecting")
    })

    room.on(RoomEvent.MediaDevicesError, (e: Error) => {
      this.cbs.onError?.(e.message || "media device error")
    })
  }

  private mapAgentState(s: string) {
    switch (s) {
      case "listening":
        this.setState("listening")
        break
      case "thinking":
        this.setState("thinking")
        break
      case "speaking":
        this.setState("speaking")
        break
      case "initializing":
        this.setState("connecting")
        break
      // Other values (e.g. "disconnected") fall through — we keep the
      // current state until the Disconnected room event fires.
    }
  }

  private startMicMetering() {
    if (this.micPollHandle !== null) return
    this.micPollHandle = window.setInterval(() => {
      const local = this.room?.localParticipant as
        | LocalParticipant
        | undefined
      if (!local) return
      this.cbs.onMicLevel?.(local.audioLevel ?? 0)
    }, 100)
  }

  private stopMicMetering() {
    if (this.micPollHandle !== null) {
      window.clearInterval(this.micPollHandle)
      this.micPollHandle = null
    }
  }

  async close(): Promise<void> {
    this.closedByCaller = true
    this.stopMicMetering()
    if (this.room) {
      try {
        await this.room.disconnect()
      } catch {
        // ignore
      }
      this.room = null
    }
    this.setState("idle")
  }
}
