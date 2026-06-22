# @cloudflare/voice-plivo

Plivo audio streaming adapter for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline. Connects phone calls to your `VoiceAgent` — the same agent that handles web voice, text chat, and email can now answer the phone.

## How it works

### Phone call

```
Phone call → Plivo → mulaw 8kHz WebSocket → PlivoAdapter → VoiceAgent (Durable Object)
                                                                  ↓
                                                            STT → LLM → TTS
                                                                  ↓
Phone speaker ← Plivo ← mulaw 8kHz audio ← PlivoAdapter ← VoiceAgent
```

### Browser (WebRTC)

The browser connects over WebRTC to Plivo, which then opens the same mulaw WebSocket to your Worker as a phone call would.

```
Browser → WebRTC → Plivo → mulaw 8kHz WebSocket → PlivoAdapter → VoiceAgent (Durable Object)
                                                                        ↓
                                                                  STT → LLM → TTS
                                                                        ↓
Browser ← WebRTC ← Plivo ← mulaw 8kHz audio ← PlivoAdapter ← VoiceAgent
```

`PlivoCallBridge` handles the WebRTC leg (browser ↔ Plivo). `PlivoAdapter` handles the WebSocket leg (Plivo ↔ Worker). The agent sees identical binary PCM either way.

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

    // Plivo fetches this when someone dials your number. Return XML that
    // tells Plivo to open an audio WebSocket to /plivo.
    if (url.pathname === "/answer") {
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

### 2. Point Plivo at your Worker

Provision the Plivo application once per deploy with `setupPlivoApplication`. It finds or creates a `cloudflare-agents-*` application, sets its answer URL, and assigns your phone number to it. It is idempotent and runs against the Plivo REST API, so it belongs in your deploy step, not the request path:

```typescript
import { setupPlivoApplication } from "@cloudflare/voice-plivo";

await setupPlivoApplication({
  authId: process.env.PLIVO_AUTH_ID,
  authToken: process.env.PLIVO_AUTH_TOKEN,
  phoneNumber: process.env.PLIVO_PHONE_NUMBER,
  answerUrl: "https://your-worker.workers.dev/answer"
});
```

The [example](../../examples/plivo-voice-agent) ships a deploy script that runs `wrangler deploy`, reads the deployed URL, and calls this automatically — one command, no manual console step.

### 3. Call

Dial your Plivo number.

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
      "@cf/deepgram/aura-2-en",
      {
        text,
        speaker: "asteria",
        encoding: "linear16",
        sample_rate: 16000,
        container: "none"
      },
      { returnRawResponse: true, ...(signal ? { signal } : {}) }
    )) as Response;
    if (!response.ok) {
      // Returning the error body would ship JSON down the audio pipeline
      // and play as silence — fail loud and skip the audio instead.
      console.error("[PlivoPCMTTS] TTS failed:", await response.text());
      return null;
    }
    return response.arrayBuffer();
  }
}

// In your VoiceAgent:
tts = new PlivoPCMTTS(this.env.AI);
```

`WorkersAITTS` outputs MP3, which the Plivo adapter cannot use directly. `PlivoPCMTTS` calls `@cf/deepgram/aura-2-en` with `encoding: "linear16"` and `container: "none"` to get raw PCM instead. See the [example](../../examples/plivo-voice-agent) for a complete implementation.

## Browser SDK

In addition to phone calls, you can connect a browser directly to your VoiceAgent via Plivo WebRTC. The browser logs in as a Plivo WebRTC endpoint and dials your Plivo number — Plivo routes the call through its infrastructure and opens the same mulaw WebSocket to your Worker as a phone call would.

```
Browser → WebRTC (PlivoCallBridge) → Plivo → mulaw 8kHz WebSocket → PlivoAdapter → VoiceAgent
Browser ← WebRTC (PlivoCallBridge) ← Plivo ← mulaw 8kHz audio ← PlivoAdapter ← VoiceAgent
```

Import from the `/browser` subpath:

```typescript
import {
  PlivoCallBridge,
  PlivoPhoneClient
} from "@cloudflare/voice-plivo/browser";
import { WebSocketVoiceTransport } from "@cloudflare/voice/client";
```

### 1. Create a Plivo WebRTC endpoint

The browser logs in as a Plivo WebRTC endpoint. Create one once (console.plivo.com → Voice → Endpoints, or the [Create Endpoint API](https://www.plivo.com/docs/voice/api/endpoint/create-an-endpoint/)) and note its username — it becomes the JWT `sub` claim.

### 2. Add a token endpoint to your Worker

```typescript
import { PlivoJWTEndpoint } from "@cloudflare/voice-plivo";

// In your fetch handler:
if (url.pathname === "/api/plivo-token") {
  const endpoint = new PlivoJWTEndpoint({
    authId: env.PLIVO_AUTH_ID,
    authToken: env.PLIVO_AUTH_TOKEN,
    endpointUsername: env.PLIVO_ENDPOINT_USERNAME,
    // Replace with a real auth check in production:
    allowUnauthenticated: true
  });
  return endpoint.handleRequest(request);
}
```

The endpoint mints a short-lived Plivo access token, signed locally (HS256) with your auth token — exactly like Plivo's server SDKs. It carries the endpoint identity (`sub`) and voice grants the browser needs to place calls. Your auth token is only the signing key and never leaves the server.

To require authentication, pass an `authorize` callback instead of `allowUnauthenticated`:

```typescript
new PlivoJWTEndpoint({
  authId: env.PLIVO_AUTH_ID,
  authToken: env.PLIVO_AUTH_TOKEN,
  endpointUsername: env.PLIVO_ENDPOINT_USERNAME,
  authorize: (request) => {
    // Check cookie, signed token, session, etc.
    return request.headers.get("Authorization") === `Bearer ${env.MY_SECRET}`;
  }
});
```

### 3. Connect from the browser

```typescript
import {
  PlivoCallBridge,
  PlivoPhoneClient
} from "@cloudflare/voice-plivo/browser";
import { WebSocketVoiceTransport } from "@cloudflare/voice/client";

// Fetch JWT and create the bridge
const response = await fetch("/api/plivo-token", { method: "POST" });
const { token } = (await response.json()) as { token: string };
const bridge = new PlivoCallBridge({ loginToken: token });

// Connect to the VoiceAgent
const client = new PlivoPhoneClient({
  transport: new WebSocketVoiceTransport({ agent: "MyAgent" }),
  bridge
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
bridge.stop();
```

### Browser SDK exports

| Export             | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `PlivoJWTEndpoint` | Server-side: issues Plivo JWTs for browser login           |
| `PlivoCallBridge`  | Browser-side: WebRTC audio capture + playback              |
| `PlivoPhoneClient` | Browser-side: voice protocol + silence/interrupt detection |

## Interrupt handling

When the caller speaks while the agent is talking, the adapter sends `clearAudio` to Plivo to cut off playback immediately. Speech is detected via energy threshold on the inbound audio — no separate VAD model required. Flux STT (`WorkersAIFluxSTT`) also fires `onSpeechStart` which triggers a pipeline abort on the agent side.

This interrupt capability is unique to Plivo's `clearAudio` event.

## Limitations

- **Call end detection**: Plivo does not send an explicit stop event when a call ends. The adapter detects call termination via WebSocket close.

## Credentials

`setupPlivoApplication` needs the first three at deploy time to provision the
application. The telephony adapter itself makes no Plivo REST calls at runtime,
so phone-only deployments need no Worker secrets. The browser token endpoint
(`PlivoJWTEndpoint`) does run in the Worker, so browser deployments need
`PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, and `PLIVO_ENDPOINT_USERNAME` as secrets.

| Variable                  | Description                                       |
| ------------------------- | ------------------------------------------------- |
| `PLIVO_AUTH_ID`           | Plivo Auth ID from console.plivo.com              |
| `PLIVO_AUTH_TOKEN`        | Plivo Auth Token from console.plivo.com           |
| `PLIVO_PHONE_NUMBER`      | Phone number in E.164 format, e.g. `+12025551234` |
| `PLIVO_ENDPOINT_USERNAME` | Plivo WebRTC endpoint username — browser SDK only |

## Same agent, every channel

The same `VoiceAgent` instance can handle:

- **Web voice** via the `@cloudflare/voice` browser client
- **Phone calls** via this Plivo adapter
- **Text chat** via `sendText()`
- **Email** via `routeAgentEmail()`

All channels share the same conversation history (SQLite), state, tools, and scheduling.
