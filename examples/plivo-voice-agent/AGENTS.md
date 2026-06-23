# AGENTS.md — examples/plivo-voice-agent

A **phone** voice agent on the Cloudflare Agents voice pipeline. A caller dials a
Plivo number and has a real-time conversation with an AI agent. All models run on
Workers AI — no third-party AI keys.

This file tells a coding agent how to get the example live and what not to break.
For the human-facing walkthrough, see `README.md`.

## Pipeline

```
Caller → Plivo number → GET /answer (returns Stream XML) → WS /plivo
      → PlivoAdapter → MyVoiceAgent (Durable Object)
      → STT @cf/deepgram/flux → LLM @cf/moonshotai/kimi-k2.6 → TTS @cf/deepgram/aura-2-en
      → audio back to caller
```

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

`npm run deploy` and `npm run dev` provision Plivo (application + number → answer URL)
at deploy time via `setupPlivoApplication`. Provisioning is **not** in the request path.

## Required env (`.env`, gitignored — never commit)

| Var                  | Source                                 |
| -------------------- | -------------------------------------- |
| `PLIVO_AUTH_ID`      | console.plivo.com → Account → Overview |
| `PLIVO_AUTH_TOKEN`   | console.plivo.com → Account → Overview |
| `PLIVO_PHONE_NUMBER` | E.164, e.g. `+12025551234`             |

This phone-only Worker needs **no secrets at runtime** — they are only used at deploy
time for provisioning.

## Key files

- `src/index.ts` — `MyVoiceAgent` (the agent), `PlivoPCMTTS`, and the `fetch` handler (`/answer` + `/plivo`)
- `scripts/deploy.ts` / `scripts/dev.ts` — deploy-time provisioning
- `wrangler.jsonc` — Worker config (Durable Object binding, AI binding)

## Don't break these

- **TTS must emit raw PCM.** Use `PlivoPCMTTS` (calls `@cf/deepgram/aura-2-en` with
  `encoding: linear16`, `container: none`). Do **not** swap in `WorkersAITTS` — it
  returns MP3 and the adapter needs linear16 PCM.
- **Keep the adapter agent-agnostic.** `PlivoAdapter` is a pure audio bridge; barge-in
  is driven by inbound speech-energy detection. Do not add agent-internal event
  handling (`playback_interrupt`, `transcript_start`, `status`) to the provider.
- **No secrets in git.** Real credentials live only in the gitignored `.env`, never in
  `.env.example`.
- Phone-only example — no browser client. The WebRTC/browser flow lives in
  `examples/plivo-browser-sdk`.
