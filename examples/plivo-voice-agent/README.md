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
VoiceAgent: STT (Workers AI Flux) → LLM (Workers AI) → TTS → audio back to caller
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set secrets

```bash
npx wrangler secret put OPENAI_API_KEY
```

Paste your OpenAI API key when prompted. This is used for TTS (text-to-speech), which outputs raw 16kHz PCM compatible with Plivo's L16 audio stream.

### 3. Deploy the Worker

```bash
npm run deploy
```

Note the deployed URL (e.g. `https://plivo-voice-agent.your-account.workers.dev`).

### 4. Configure Plivo

In the [Plivo console](https://console.plivo.com):

Go to **Phone Numbers** → select your number → set the **Answer URL** to:

```
https://plivo-voice-agent.your-account.workers.dev/answer
```

Set the HTTP method to **GET** and save.

The Worker's `/answer` endpoint dynamically returns the Stream XML that tells Plivo to open a bidirectional audio WebSocket to `/plivo`.

### 5. Make a test call

Dial your Plivo number. The agent will greet you and respond to your questions. You can interrupt the agent mid-sentence and it will stop and listen.

## Local development

```bash
npm run dev
```

For local testing with Plivo, expose your local Worker using [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):

```bash
cloudflared tunnel --url http://localhost:8787
```

Use the tunnel URL as your Plivo Answer URL during development.

## Audio format

The Stream XML uses `contentType="audio/x-l16;rate=16000"`, which means:

- **Inbound** (Plivo → Worker): 16kHz 16-bit PCM, base64-encoded — decoded and forwarded directly to the voice pipeline
- **Outbound** (Worker → Plivo): 16kHz 16-bit PCM from TTS, base64-encoded and sent as `playAudio` events

This is simpler than Twilio (which uses mulaw 8kHz and requires codec conversion).

## Barge-in / interruption

When the caller speaks while the agent is talking, the agent stops mid-response and listens immediately. This works via Plivo's `clearAudio` event, which the adapter sends whenever the voice pipeline detects barge-in.
