# plivo-voice-agent

A minimal voice agent that answers Plivo phone calls using the Cloudflare Agents voice pipeline. Dial a Plivo number and have a real-time voice conversation with an AI.

## How it works

```
Caller dials Plivo number
       ↓
Plivo fetches /answer → receives Stream XML → opens WebSocket to /plivo
       ↓
PlivoAdapter bridges the audio stream to MyVoiceAgent (Durable Object)
       ↓
VoiceAgent: STT (Workers AI) → LLM (Workers AI) → TTS (Workers AI) → audio back to caller
```

Uses Workers AI for all models — no external API keys required.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set secrets

Copy `.dev.vars.example` to `.dev.vars` and fill in your Plivo credentials:

```
PLIVO_AUTH_ID=your_auth_id
PLIVO_AUTH_TOKEN=your_auth_token
PLIVO_PHONE_NUMBER=+12025551234
```

These are available from [console.plivo.com](https://console.plivo.com).

### 3. Deploy the Worker

```bash
npm run deploy
```

Note the deployed URL (e.g. `https://plivo-voice-agent.your-account.workers.dev`).

### 4. Make a test call

Dial your Plivo number. On the first call, the Worker automatically creates a Plivo application and assigns your phone number to it — no manual console configuration needed.

The agent will greet you and respond to your questions. You can interrupt the agent mid-sentence and it will stop and listen.

## Local development

```bash
npm run dev
```

For local testing with Plivo, expose your local Worker using [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):

```bash
cloudflared tunnel --url http://localhost:8787
```

Use the tunnel URL as your Plivo Answer URL during local development.

## Audio format

The Stream XML uses `contentType="audio/x-mulaw;rate=8000"` — the native PSTN audio format used across all telecom providers.

- **Inbound** (Plivo → Worker): mulaw 8kHz, decoded and resampled to 16kHz PCM before the voice pipeline
- **Outbound** (Worker → Plivo): 16kHz PCM from TTS, resampled to 8kHz and mulaw-encoded before playback

## Barge-in / interruption

When the caller speaks while the agent is talking, the agent stops mid-response and listens immediately. This works via Plivo's `clearAudio` event, which the adapter sends whenever speech energy is detected from the caller.
