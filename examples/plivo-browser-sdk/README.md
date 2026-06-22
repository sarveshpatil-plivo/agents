# Plivo Browser SDK

A browser voice agent built on the Cloudflare Agents voice pipeline. Talk to an AI directly from your browser over Plivo WebRTC — no phone required. All models run on Workers AI; no third-party AI keys are required.

## How it works

```
Browser (Plivo WebRTC) → logs in as WebRTC endpoint → places call to Plivo number
        ↓
Plivo fetches /answer → returns Stream XML → opens WebSocket to /plivo
        ↓
PlivoAdapter bridges the audio stream to MyVoiceAgent (Durable Object)
        ↓
STT: Workers AI Flux (@cf/deepgram/flux)
        ↓
LLM: Workers AI Kimi K2.6 (@cf/moonshotai/kimi-k2.6)
        ↓
TTS: Workers AI Deepgram Aura 2 (@cf/deepgram/aura-2-en, linear16 PCM)
        ↓
Audio back to browser via Plivo WebRTC
```

The browser never connects directly to the agent. It logs in as a Plivo WebRTC endpoint, places a call to your Plivo number, and the call is routed through the same PSTN path as a phone call — `/answer` → `/plivo` → `PlivoAdapter` → `MyVoiceAgent`.

## Prerequisites

1. A Plivo account with a voice-enabled phone number ([console.plivo.com](https://console.plivo.com))
2. A Plivo WebRTC endpoint — create one at console.plivo.com → Voice → Endpoints (note the username)
3. A Cloudflare account with [Workers AI](https://developers.cloudflare.com/workers-ai/) access
4. Wrangler authenticated with your Cloudflare account (`npx wrangler login`)

## Setup

### 1. Install and build

From the repository root:

```bash
npm install
npm run build
```

The build compiles the workspace packages the example imports.

### 2. Configure credentials

```bash
cd examples/plivo-browser-sdk
cp .env.example .env
```

Fill in `.env`:

- `PLIVO_AUTH_ID` and `PLIVO_AUTH_TOKEN` from console.plivo.com → Account → Overview
- `PLIVO_PHONE_NUMBER` in E.164 format, e.g. `+12025551234`
- `PLIVO_ENDPOINT_USERNAME` — the username of the WebRTC endpoint from step 2

### 3. Deploy

```bash
npm run deploy
```

This runs `wrangler deploy`, uploads your `.env` values as Worker secrets (the token endpoint needs them at runtime), reads the deployed Worker URL, and points your Plivo application and phone number at it — all automatically.

### 4. Open the browser client

Navigate to the deployed Worker URL. Click **Connect** — the page logs in as your WebRTC endpoint, places a call to your Plivo number, and connects to the agent.

## Token endpoint

The Worker serves `/api/plivo-token` — a `PlivoJWTEndpoint` that mints a short-lived Plivo access token signed locally with your auth token (HS256). The token carries the endpoint username (`sub`) and voice grants needed to place calls. The auth token stays on the server; the browser only receives the signed JWT.

The example sets `allowUnauthenticated: true` for demos — configure an `authorize` callback before exposing the endpoint publicly.

## Local development

```bash
npm run dev
```

Plivo's cloud needs a public URL to reach `/answer`, so `npm run dev` starts the Worker, opens a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) tunnel, and points your Plivo application at the tunnel URL. Install `cloudflared` first; the script prints a link if it's missing. Run `npm run deploy` afterward to point Plivo back at your deployed Worker.
