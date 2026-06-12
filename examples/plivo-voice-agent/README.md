# plivo-voice-agent

A minimal voice agent that answers Plivo phone calls using the Cloudflare Agents voice pipeline. Dial a Plivo number and have a real-time voice conversation with an AI — all models run on Workers AI, no external API keys required.

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
3. Node.js 24+
4. Wrangler authenticated with your Cloudflare account — run `npx wrangler login` once

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

Copy `.dev.vars.example` to `.dev.vars` and fill in your Plivo credentials:

```bash
cp .dev.vars.example .dev.vars
```

```
PLIVO_AUTH_ID=your_auth_id
PLIVO_AUTH_TOKEN=your_auth_token
PLIVO_PHONE_NUMBER=+12025551234
```

Get these from [console.plivo.com](https://console.plivo.com) → Account → Overview.

### 3. Deploy

```bash
npm run deploy
```

### 4. Make a test call

Dial your Plivo number. The agent will greet you immediately and respond to your questions. You can interrupt the agent mid-sentence and it will stop and listen.

## Local development

```bash
npm run dev
```

For local testing with Plivo, expose your local Worker using [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):

```bash
cloudflared tunnel --url http://localhost:8787
```

Use the tunnel URL as your Plivo Answer URL.

## For deployed Workers, set secrets via Wrangler

```bash
wrangler secret put PLIVO_AUTH_ID
wrangler secret put PLIVO_AUTH_TOKEN
wrangler secret put PLIVO_PHONE_NUMBER
```

Secrets set via `wrangler secret put` persist across deploys. Environment variables set in the Cloudflare dashboard are wiped on each deploy.
