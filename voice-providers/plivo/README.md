# @cloudflare/voice-plivo

Plivo audio streaming adapter for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline. Connects phone calls to your `VoiceAgent` — the same agent that handles web voice, text chat, and email can now answer the phone.

## How it works

```
Phone call → Plivo → Audio Streaming WebSocket → PlivoAdapter → VoiceAgent (Durable Object)
                                                                      ↓
                                                                STT → LLM → TTS
                                                                      ↓
Phone speaker ← Plivo ← audio ← PlivoAdapter ← VoiceAgent
```

The adapter bridges Plivo's bidirectional audio streaming protocol to VoiceAgent's binary PCM protocol (16kHz, 16-bit LE). It supports all three Plivo content types, auto-detected from the `start` event:

- `audio/x-l16;rate=16000` — no conversion needed, recommended for lowest latency
- `audio/x-l16;rate=8000` — resampled to/from 16kHz
- `audio/x-mulaw;rate=8000` — mulaw decoded/encoded and resampled to/from 16kHz

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

## Interrupt handling

When the caller speaks while the agent is talking, the adapter sends `clearAudio` to Plivo to cut off playback immediately. This is handled in two ways: if the voice pipeline is still active, `playback_interrupt` triggers it directly. If the pipeline has already finished sending audio (Plivo may still be playing buffered chunks), the adapter detects speech energy in the inbound audio and sends `clearAudio` independently.

This is a capability Twilio does not support.

## Limitations

- **Call end detection**: Plivo does not send an explicit stop event when a call ends — the adapter detects call termination via WebSocket close. This is different from Twilio, which sends an explicit `stop` event.

## Same agent, every channel

The same `VoiceAgent` instance can handle:

- **Web voice** via `VoiceClient` / `useVoiceAgent`
- **Phone calls** via this Plivo adapter
- **Text chat** via `sendText()`
- **Email** via `routeAgentEmail()`

All channels share the same conversation history (SQLite), state, tools, and scheduling.
