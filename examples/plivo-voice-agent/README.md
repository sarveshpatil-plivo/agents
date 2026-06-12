# Plivo Phone Voice Agent

A phone voice agent built on the Cloudflare Agents voice pipeline. Dial a Plivo number and have a real-time conversation with an AI agent. All models run on Workers AI; no third-party AI keys are required.

## How it works

```
Caller dials Plivo number
        ↓
Plivo fetches /answer → returns Stream XML → Plivo opens WebSocket to /plivo
        ↓
PlivoAdapter bridges the audio stream to MyVoiceAgent (Durable Object)
        ↓
STT: Workers AI Flux (@cf/deepgram/flux)
        ↓
LLM: Workers AI GLM-4.7 Flash (@cf/zai-org/glm-4.7-flash)
        ↓
TTS: Workers AI Deepgram Aura (@cf/deepgram/aura-1, linear16 PCM)
        ↓
Audio back to caller via Plivo
```

## Prerequisites

1. A Plivo account with a voice-enabled phone number ([console.plivo.com](https://console.plivo.com))
2. A Cloudflare account with [Workers AI](https://developers.cloudflare.com/workers-ai/) access
3. Wrangler authenticated with your Cloudflare account (`npx wrangler login`)

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
cd examples/plivo-voice-agent
cp .env.example .env
```

Fill in `.env` with the values from [console.plivo.com](https://console.plivo.com) → Account → Overview. The phone number uses E.164 format, e.g. `+12025551234`. Then upload the values as Worker secrets:

```bash
npx wrangler secret bulk .env
```

### 3. Deploy

```bash
npm run deploy
```

### 4. Register the answer URL

Open `https://plivo-voice-agent.<your-subdomain>.workers.dev/answer` once. The Stream XML response confirms that `PlivoAdapter.setup()` created a Plivo application and assigned the phone number to it. Plivo routes calls to the Worker from this point on.

### 5. Call

Dial the Plivo number. The agent greets the caller and responds in real time. Speaking over the agent interrupts playback.

## Browser voice (WebRTC)

`public/index.html` serves a browser client for the same agent over Plivo WebRTC. Open the deployed Worker URL and click Connect.

The `/api/plivo-token` endpoint issues a short-lived Plivo JWT through `PlivoJWTEndpoint`, so the auth token never reaches the browser. The example sets `allowUnauthenticated: true` for local demos. Configure an `authorize` callback before exposing the endpoint publicly.

## Local development

`wrangler dev` reads `.env`:

```bash
npm run dev
```

Plivo cannot reach localhost, so expose the dev server with [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):

```bash
cloudflared tunnel --url http://localhost:8787
```

Open `/answer` on the tunnel URL to point the Plivo application at the tunnel, and on the deployed URL to point it back.
