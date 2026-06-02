# @cloudflare/voice-plivo

Plivo audio streaming adapter for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline. Connects phone calls to your `VoiceAgent` — the same agent that handles web voice, text chat, and email can now answer the phone.

## How it works

```
Phone call → Plivo → Audio Streaming WebSocket → PlivoAdapter → VoiceAgent (Durable Object)
                                                                      ↓
                                                                STT → LLM → TTS
                                                                      ↓
Phone speaker ← Plivo ← L16 16kHz audio ← PlivoAdapter ← VoiceAgent
```

The adapter bridges Plivo's bidirectional audio streaming protocol (L16 16kHz, base64 JSON) to VoiceAgent's binary PCM protocol (16kHz, 16-bit LE). Because Plivo supports sending audio as L16 16kHz PCM natively, no codec conversion or resampling is needed — the adapter simply unwraps and forwards the audio in both directions.

## Install

```bash
npm install @cloudflare/voice-plivo
```

## Usage

### 1. Add the adapter to your Worker

```typescript
import { Agent, routeAgentRequest } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { PlivoAdapter } from "@cloudflare/voice-plivo";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  async onTurn(transcript: string, context: VoiceTurnContext) {
    return "Hello! How can I help you?";
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/plivo") {
      return PlivoAdapter.handleRequest(request, env, "MyAgent");
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

### 2. Configure Plivo Answer XML

Create an XML document (or host a webhook that returns it) to instruct Plivo to stream audio to your Worker:

```xml
<Response>
  <Stream
    keepCallAlive="true"
    bidirectional="true"
    contentType="audio/x-l16;rate=16000"
  >wss://your-worker.your-account.workers.dev/plivo</Stream>
</Response>
```

The `contentType="audio/x-l16;rate=16000"` attribute is important — it tells Plivo to send 16kHz linear PCM, which is the format VoiceAgent expects. This avoids any codec conversion.

### 3. Assign a phone number

In the Plivo console:

1. Go to **Phone Numbers** and buy or select a number
2. Set the **Answer URL** to the URL of your XML document (or the webhook that returns it)
3. Set the **Answer Method** to `GET` or `POST` depending on your setup

When someone calls that number, Plivo fetches the XML, opens a WebSocket stream to your Worker, and the audio flows to your VoiceAgent.

## Options

```typescript
PlivoAdapter.handleRequest(request, env, "MyAgent", {
  // Use a custom instance name instead of the Plivo Call ID
  instanceName: "shared-agent"
});
```

By default, each phone call creates a new VoiceAgent instance (using the Plivo Call ID as the instance name). Set `instanceName` to route multiple calls to the same agent instance.

## Limitations

- **TTS output format**: VoiceAgent's default TTS (Workers AI Deepgram Aura) outputs MP3. Plivo expects L16 PCM. For production use, configure a TTS provider that outputs raw PCM (e.g., ElevenLabs with `output_format: "pcm_16000"`), or use the `beforeSynthesize`/`afterSynthesize` hooks to handle format conversion.
- **Call end detection**: Plivo does not send an explicit stop event when a call ends — the adapter detects call termination via WebSocket close. This is different from Twilio, which sends an explicit `stop` event.

## Same agent, every channel

The same `VoiceAgent` instance can handle:

- **Web voice** via `VoiceClient` / `useVoiceAgent`
- **Phone calls** via this Plivo adapter
- **Text chat** via `sendText()`
- **Email** via `routeAgentEmail()`

All channels share the same conversation history (SQLite), state, tools, and scheduling.
