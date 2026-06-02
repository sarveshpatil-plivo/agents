# plivo-voice-agent

A minimal voice agent that answers Plivo phone calls using the Cloudflare Agents voice pipeline. Dial a Plivo number and have a real-time voice conversation with an AI.

## How it works

```
Caller dials Plivo number
       ↓
Plivo fetches your Answer XML → opens WebSocket to this Worker
       ↓
PlivoAdapter bridges the audio stream to VoiceAgent
       ↓
VoiceAgent: STT → LLM (Workers AI) → TTS → audio back to caller
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Deploy the Worker

```bash
npm run deploy
```

Note the deployed Worker URL (e.g. `https://plivo-voice-agent.your-account.workers.dev`).

### 3. Configure Plivo

In the [Plivo console](https://console.plivo.com):

**Create an Answer XML document:**

Go to **Voice** → **XML** → **Create new XML** and paste:

```xml
<Response>
  <Stream
    keepCallAlive="true"
    bidirectional="true"
    contentType="audio/x-l16;rate=16000"
  >wss://plivo-voice-agent.your-account.workers.dev/plivo</Stream>
</Response>
```

Replace the URL with your actual Worker URL.

**Assign to a phone number:**

Go to **Phone Numbers** → select your number → set **Answer URL** to the URL of the XML above → save.

### 4. Make a test call

Dial your Plivo number. The agent will greet you and respond to your questions.

## Local development

```bash
npm run dev
```

For local testing with Plivo, you'll need a tunneling tool like [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) to expose your local Worker to the internet:

```bash
cloudflared tunnel --url http://localhost:8787
```

Use the tunnel URL in your Plivo Answer XML during development.

## Limitations

- **TTS output format**: Workers AI TTS (Deepgram Aura) outputs MP3. For production, configure a TTS provider that outputs raw PCM — e.g. ElevenLabs with `output_format: "pcm_16000"`. See the `@cloudflare/voice-plivo` README for details.
