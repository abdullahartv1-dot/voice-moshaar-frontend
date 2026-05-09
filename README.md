# مستشار للصوت — Frontend

Vite + React 19 + Capacitor 7 frontend for the **Mostashar Voice** API
([abdullahartv1-dot/mostashar-voice](https://github.com/abdullahartv1-dot/mostashar-voice)).

Voice cloning · TTS · ASR (speech-to-text + diarization) · live-call (coming soon).

## Stack

- React 19 · TypeScript (strict) · Vite 8
- Tailwind CSS 4 · shadcn/ui · Radix UI · lucide-react
- TanStack Query · React Hook Form · Zod · Jotai
- React Router 6 · i18next (Arabic + English, RTL)
- Axios · Socket.io · Firebase · Leaflet
- Capacitor 7 (Android + iOS shells)

## Pages

| Path | Page |
|---|---|
| `/library` | Pick a voice, generate TTS, manage your library |
| `/clone` | Clone a new voice from 3-30s reference audio |
| `/transcribe` | Speech-to-text with speaker diarization + timestamps |
| `/call` | Live call with the AI agent (coming soon, Phase 3) |

## Quick start

```bash
# 1. Install
npm install

# 2. Configure backend
cp .env.example .env.local
# Edit .env.local: set VITE_API_KEY (and VITE_BACKEND_URL for prod)

# 3. Run a dev server (uses Vite's proxy on /v1 → 127.0.0.1:8080 by default)
npm run dev
```

For local development, run the backend on the same machine (or open an SSH
tunnel from your dev machine to the GPU pod):

```bash
ssh -i ~/.ssh/id_ed25519 -p PORT -L 8080:localhost:8080 -N -f root@POD_HOST
```

## Capacitor (mobile)

```bash
# Add native projects (one-time)
npm run cap:add:android
npm run cap:add:ios

# Build web → sync to native
npm run build && npm run cap:sync

# Open in Android Studio / Xcode
npm run cap:open:android
npm run cap:open:ios

# Live-reload on device
npm run cap:run:android
```

## Project layout

```
src/
├── api/              ← axios client + react-query hooks + WS helper
├── components/
│   ├── ui/           ← shadcn primitives + voice-picker + audio-player + orb
│   ├── nav-bar.tsx
│   ├── layout.tsx
│   └── theme-provider.tsx
├── pages/            ← lazy-loaded route components
├── lib/              ← cn(), formatDuration()
├── i18n/             ← i18next config + ar.json + en.json (RTL aware)
├── store/            ← Jotai atoms (theme, selected voice, audio state)
└── types/            ← TypeScript types matching backend v1 API
```

## License

MIT.
