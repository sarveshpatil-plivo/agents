# AGENTS.md — examples/plivo-browser-sdk

A **browser** voice agent on the Cloudflare Agents voice pipeline. Talk to an AI
directly from the browser over Plivo WebRTC — no phone required. All models run on
Workers AI — no third-party AI keys.

This file tells a coding agent how to get the example live and what not to break.
For the human-facing walkthrough, see `README.md`.

## Pipeline

```
Browser → WebRTC (PlivoCallBridge) → Plivo → mulaw 8kHz WS → PlivoAdapter → VoiceAgent
                                                                                ↓
                                                                      STT → LLM → TTS
Browser ← WebRTC (PlivoCallBridge) ← Plivo ← mulaw 8kHz audio ← PlivoAdapter ← VoiceAgent
```

The browser fetches a short-lived JWT from `/api/plivo-token` (a `PlivoJWTEndpoint`),
`PlivoCallBridge` logs in as a Plivo WebRTC endpoint and dials the number, and Plivo
opens the same mulaw 8kHz WebSocket to the Worker that a phone call would. From the
agent's perspective a browser call is identical to a phone call.

Models: STT `@cf/deepgram/flux`, LLM `@cf/moonshotai/kimi-k2.6`, TTS `@cf/deepgram/aura-2-en`.

## Run it

From the repo root first:

```bash
npm install
npm run build          # compiles the workspace packages the example imports
```

Then in this folder:

```bash
cp .env.example .env   # fill in real values (see below)
npm run deploy         # wrangler deploy + upload secrets + point Plivo app/number at the Worker
npm run dev            # local: starts Worker + cloudflared tunnel + points Plivo at the tunnel
```

After deploy, open the Worker URL in a browser and click **Connect**.

## Required env (`.env`, gitignored — never commit)

| Var                       | Source                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| `PLIVO_AUTH_ID`           | console.plivo.com → Account → Overview                             |
| `PLIVO_AUTH_TOKEN`        | console.plivo.com → Account → Overview                             |
| `PLIVO_PHONE_NUMBER`      | E.164, e.g. `+12025551234`                                         |
| `PLIVO_ENDPOINT_USERNAME` | a WebRTC endpoint username (console.plivo.com → Voice → Endpoints) |

Unlike the phone-only example, this Worker **needs the secrets at runtime** — the
token endpoint mints the JWT on each request. Deploy uploads them as Worker secrets.

## Key files

- `src/index.ts` — `MyVoiceAgent`, `PlivoPCMTTS`, and the `fetch` handler (`/answer`,
  `/plivo`, `/api/plivo-token`, `/api/config`)
- `public/index.html` — the browser client (loads `PlivoCallBridge`)
- `scripts/deploy.ts` / `scripts/dev.ts` — deploy-time provisioning

## Don't break these

- **TTS must emit raw PCM.** Use `PlivoPCMTTS` (`@cf/deepgram/aura-2-en`,
  `encoding: linear16`, `container: none`). Do **not** swap in `WorkersAITTS` (MP3).
- **Keep the adapter agent-agnostic.** `PlivoAdapter` is a pure audio bridge; barge-in
  is driven by inbound speech-energy detection. No agent-internal event handling
  (`playback_interrupt`, `transcript_start`, `status`) in the provider.
- **JWT auth.** `PlivoJWTEndpoint` signs the token locally (HS256) with the auth token,
  which stays on the server. The example uses `allowUnauthenticated: true` for demos —
  set an `authorize` callback before exposing it publicly.
- **No secrets in git.** Real credentials live only in the gitignored `.env`.
