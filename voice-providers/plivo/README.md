# @cloudflare/voice-plivo

Plivo audio streaming adapter for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline. Connects phone calls to your `VoiceAgent` — the same agent that handles web voice, text chat, and email can now answer the phone.

## How it works

```
Phone call → Plivo → Audio Streaming WebSocket → PlivoAdapter → VoiceAgent (Durable Object)
                                                                      ↓
                                                                STT → LLM → TTS
                                                                      ↓
Phone speaker ← Plivo ← mulaw 8kHz audio ← PlivoAdapter ← VoiceAgent
```

The adapter bridges Plivo's bidirectional audio streaming protocol to VoiceAgent's binary PCM protocol (16kHz, 16-bit LE). Audio resampling and mulaw encoding/decoding happen automatically.

## Install

```bash
npm install @cloudflare/voice-plivo
```

## Usage

### 1. Add the adapter to your Worker

Two endpoints are needed — `/answer` (Plivo fetches this when a call comes in) and `/plivo` (Plivo streams audio here via WebSocket):

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

    // Plivo calls this when someone dials your number.
    // Returns XML that tells Plivo to open an audio WebSocket to /plivo.
    // PlivoAdapter.setup() auto-configures your Plivo application and
    // phone number on the first call — no manual console setup needed.
    if (url.pathname === "/answer") {
      await PlivoAdapter.setup({
        authId: env.PLIVO_AUTH_ID,
        authToken: env.PLIVO_AUTH_TOKEN,
        phoneNumber: env.PLIVO_PHONE_NUMBER,
        answerUrl: `https://${url.host}/answer`
      });

      const wsUrl = `wss://${url.host}/plivo`;
      const xml = `<Response><Stream keepCallAlive="true" bidirectional="true" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream></Response>`;
      return new Response(xml, {
        headers: { "Content-Type": "application/xml" }
      });
    }

    // Plivo streams call audio here over a WebSocket.
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

### 2. Set secrets and deploy

```bash
wrangler secret put PLIVO_AUTH_ID
wrangler secret put PLIVO_AUTH_TOKEN
wrangler secret put PLIVO_PHONE_NUMBER
wrangler deploy
```

### 3. Make a call

Dial your Plivo number. On the first call, `PlivoAdapter.setup()` automatically creates a Plivo application and assigns your phone number to it — no manual Plivo console configuration needed.

## Options

```typescript
PlivoAdapter.handleRequest(request, env, "MyAgent", {
  // Use a custom instance name instead of the Plivo Call ID
  instanceName: "shared-agent"
});
```

By default, each phone call creates a new VoiceAgent instance (using the Plivo Call ID as the instance name). Set `instanceName` to route multiple calls to the same agent instance.

## TTS output format

VoiceAgent's default TTS (`WorkersAITTS`) outputs MP3. The Plivo adapter expects raw PCM to encode as mulaw. For production use, configure a TTS provider that outputs PCM directly:

```typescript
import { type TTSProvider } from "@cloudflare/voice";

class PlivoPCMTTS implements TTSProvider {
  constructor(private ai: Ai) {}

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const response = (await this.ai.run(
      "@cf/deepgram/aura-1",
      {
        text,
        speaker: "asteria",
        encoding: "linear16",
        sample_rate: 16000,
        container: "none"
      },
      { returnRawResponse: true, ...(signal ? { signal } : {}) }
    )) as Response;
    return response.arrayBuffer();
  }
}

// In your VoiceAgent:
tts = new PlivoPCMTTS(this.env.AI);
```

This calls the same `@cf/deepgram/aura-1` model used by `WorkersAITTS`, but requests raw linear16 PCM output instead of MP3. See the [example](../../examples/plivo-voice-agent) for a complete implementation.

## Browser SDK

In addition to phone calls, you can connect a browser directly to your VoiceAgent via Plivo WebRTC. Import from the `/browser` subpath:

```typescript
import {
  createPlivoVoiceConfig,
  PlivoPhoneClient
} from "@cloudflare/voice-plivo/browser";
import { WebSocketVoiceTransport } from "@cloudflare/voice/client";
```

### 1. Add a token endpoint to your Worker

```typescript
import { PlivoJWTEndpoint } from "@cloudflare/voice-plivo";

// In your fetch handler:
if (url.pathname === "/api/plivo-token") {
  const endpoint = new PlivoJWTEndpoint({
    authId: env.PLIVO_AUTH_ID,
    authToken: env.PLIVO_AUTH_TOKEN,
    // Replace with a real auth check in production:
    allowUnauthenticated: true
  });
  return endpoint.handleRequest(request);
}
```

The endpoint issues a short-lived Plivo JWT. The browser uses it to register as a WebRTC endpoint — your auth token never leaves the server.

To require authentication, pass an `authorize` callback instead of `allowUnauthenticated`:

```typescript
new PlivoJWTEndpoint({
  authId: env.PLIVO_AUTH_ID,
  authToken: env.PLIVO_AUTH_TOKEN,
  authorize: (request) => {
    // Check cookie, signed token, session, etc.
    return request.headers.get("Authorization") === `Bearer ${env.MY_SECRET}`;
  }
});
```

### 2. Connect from the browser

```typescript
import {
  createPlivoVoiceConfig,
  PlivoPhoneClient
} from "@cloudflare/voice-plivo/browser";
import { WebSocketVoiceTransport } from "@cloudflare/voice/client";

// Fetch JWT and create the WebRTC bridge
const plivo = await createPlivoVoiceConfig({
  jwtEndpoint: "/api/plivo-token",
  autoAnswer: true // auto-answer inbound calls
});

// Connect to the VoiceAgent
const client = new PlivoPhoneClient({
  transport: new WebSocketVoiceTransport({ agent: "MyAgent" }),
  bridge: plivo.bridge
});

client.addEventListener("statuschange", (status) =>
  console.log("status:", status)
);
client.addEventListener("transcriptchange", (msgs) => console.log(msgs));

client.connect();
client.addEventListener("connectionchange", async (connected) => {
  if (connected) await client.startCall();
});

// When done:
client.disconnect();
plivo.cleanup();
```

### Browser SDK exports

| Export                   | Description                                                     |
| ------------------------ | --------------------------------------------------------------- |
| `PlivoJWTEndpoint`       | Server-side: issues Plivo JWTs for browser login                |
| `PlivoCallBridge`        | Browser-side: WebRTC audio capture + playback                   |
| `PlivoPhoneClient`       | Browser-side: voice protocol + silence/interrupt detection      |
| `PlivoPhoneTransport`    | Browser-side: transport wrapper that routes audio to the bridge |
| `createPlivoVoiceConfig` | Helper: fetch token + create bridge in one call                 |

## Interrupt handling

When the caller speaks while the agent is talking, the adapter sends `clearAudio` to Plivo to cut off playback immediately. Speech is detected via energy threshold on the inbound audio — no separate VAD model required. Flux STT (`WorkersAIFluxSTT`) also fires `onSpeechStart` which triggers a pipeline abort on the agent side.

This interrupt capability is unique to Plivo's `clearAudio` event.

## Limitations

- **Call end detection**: Plivo does not send an explicit stop event when a call ends. The adapter detects call termination via WebSocket close.

## Environment variables

| Variable             | Required | Description                                       |
| -------------------- | -------- | ------------------------------------------------- |
| `PLIVO_AUTH_ID`      | Yes      | Plivo Auth ID from console.plivo.com              |
| `PLIVO_AUTH_TOKEN`   | Yes      | Plivo Auth Token from console.plivo.com           |
| `PLIVO_PHONE_NUMBER` | Yes      | Phone number in E.164 format, e.g. `+12025551234` |

Set secrets with Wrangler:

```bash
wrangler secret put PLIVO_AUTH_ID
wrangler secret put PLIVO_AUTH_TOKEN
wrangler secret put PLIVO_PHONE_NUMBER
```

## Same agent, every channel

The same `VoiceAgent` instance can handle:

- **Web voice** via browser SDK (`PlivoCallBridge` / `PlivoPhoneClient`)
- **Phone calls** via this Plivo adapter
- **Text chat** via `sendText()`
- **Email** via `routeAgentEmail()`

All channels share the same conversation history (SQLite), state, tools, and scheduling.
