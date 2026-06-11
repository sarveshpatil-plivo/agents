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

The adapter bridges Plivo's bidirectional audio streaming protocol to VoiceAgent's binary PCM protocol (16kHz, 16-bit LE). It uses `audio/x-mulaw;rate=8000` — the native PSTN format — decoding and resampling inbound audio to 16kHz for the voice pipeline, and encoding outbound audio back to 8kHz mulaw for Plivo.

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

### 2. Add an `/answer` endpoint and call `setup()`

The adapter can auto-configure your Plivo application and phone number. Add an `/answer` route that returns the Stream XML and calls `PlivoAdapter.setup()`:

```typescript
if (url.pathname === "/answer") {
  await PlivoAdapter.setup({
    authId: env.PLIVO_AUTH_ID,
    authToken: env.PLIVO_AUTH_TOKEN,
    phoneNumber: env.PLIVO_PHONE_NUMBER,
    answerUrl: `https://${url.host}/answer`
  });

  const wsUrl = `wss://${url.host}/plivo`;
  const xml = `<Response><Stream keepCallAlive="true" bidirectional="true" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream></Response>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
```

On the first call, `setup()` creates a Plivo application and assigns your phone number to it. Subsequent calls are no-ops — no manual Plivo console configuration needed.

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
