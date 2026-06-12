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

### 2. Configure credentials

Put your Plivo credentials in `.dev.vars`, then upload them as Worker secrets in one command:

```bash
cp .dev.vars.example .dev.vars   # fill in your values
npx wrangler secret bulk .dev.vars
```

Get the values from [console.plivo.com](https://console.plivo.com) → Account → Overview. Use E.164 format for the phone number, e.g. `+12025551234`.

`.dev.vars` is the single source of truth: `wrangler dev` reads it directly for local development, and `secret bulk` uploads the same values for the deployed Worker. Re-run `secret bulk` whenever the values change. Secrets persist across deploys. If wrangler says the Worker doesn't exist yet, run step 3 first, then come back.

### 3. Deploy

```bash
npm run deploy
```

The output prints your Worker URL, e.g. `https://plivo-voice-agent.<your-subdomain>.workers.dev`.

### 4. Point Plivo at your Worker

Open `https://plivo-voice-agent.<your-subdomain>.workers.dev/answer` in a browser once. When you see the Stream XML response, `PlivoAdapter.setup()` has created a Plivo application and assigned your phone number to it — no manual Plivo console configuration needed.

This step is required before the first call: Plivo only knows where to send calls after the answer URL is registered.

### 5. Make a test call

Dial your Plivo number. The agent will greet you immediately and respond to your questions. You can interrupt the agent mid-sentence and it will stop and listen.

## Local development

`wrangler dev` reads the `.dev.vars` you created in step 2, so the dev server just starts:

```bash
npm run dev
```

Plivo's cloud can't reach localhost, so expose the local Worker using [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):

```bash
cloudflared tunnel --url http://localhost:8787
```

Then open `https://<tunnel-url>/answer` once to re-point your Plivo application at the tunnel. When you are done, open `/answer` on the deployed Worker URL to point it back.
