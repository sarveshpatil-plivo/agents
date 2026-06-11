/**
 * Plivo audio streaming adapter for the Agents voice pipeline.
 *
 * Bridges Plivo's bidirectional audio streaming WebSocket protocol
 * to VoiceAgent's binary PCM + JSON voice protocol.
 *
 * Plivo sends: base64-encoded audio in one of three formats negotiated via
 * the Stream XML contentType attribute. All formats are normalised to
 * 16kHz 16-bit PCM before being forwarded to VoiceAgent, and agent PCM is
 * converted back to the negotiated format before playback.
 *
 * Supported contentType values:
 *   - audio/x-l16;rate=16000  (no conversion — recommended)
 *   - audio/x-l16;rate=8000   (resampled to/from 16kHz)
 *   - audio/x-mulaw;rate=8000 (mulaw decoded/encoded + resampled)
 *
 * @example
 * ```typescript
 * import { withVoice } from "@cloudflare/voice";
 * import { PlivoAdapter } from "@cloudflare/voice-plivo";
 *
 * export class MyAgent extends VoiceAgent<Env> {
 *   async onTurn(transcript: string, context: VoiceTurnContext) {
 *     return "Hello! How can I help you?";
 *   }
 * }
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     if (new URL(request.url).pathname === "/plivo") {
 *       return PlivoAdapter.handleRequest(request, env, "MyAgent");
 *     }
 *     return routeAgentRequest(request, env);
 *   }
 * };
 * ```
 */

// --- Audio utilities ---

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const view = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return view;
}

/** Exported for use in tests. */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const view = base64ToUint8Array(b64);
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer;
}

/** Exported for use in tests. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
}

// mulaw decode table — maps each mulaw byte to a 16-bit linear PCM sample.
const MULAW_DECODE_TABLE = new Int16Array(256);
{
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
  }
}

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function decodeMulaw(data: Uint8Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = MULAW_DECODE_TABLE[data[i]];
  }
  return out;
}

function encodeMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (; exponent > 0; exponent--) {
    if (sample & 0x4000) break;
    sample <<= 1;
  }
  const mantissa = (sample >> 10) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function resamplePCM(
  input: Int16Array,
  fromRate: number,
  toRate: number
): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const idx = Math.floor(srcIndex);
    const frac = srcIndex - idx;
    const a = input[idx] ?? 0;
    const b = input[Math.min(idx + 1, input.length - 1)] ?? 0;
    output[i] = Math.round(a + frac * (b - a));
  }
  return output;
}

// --- Plivo protocol types ---

interface PlivoStartMessage {
  event: "start";
  sequenceNumber: number;
  start: {
    callId: string;
    streamId: string;
    accountId: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
    };
  };
}

interface PlivoMediaMessage {
  event: "media";
  sequenceNumber: number;
  streamId: string;
  media: {
    track: string;
    timestamp: string;
    chunk: number;
    payload: string;
  };
}

interface PlivoDtmfMessage {
  event: "dtmf";
  sequenceNumber: number;
  streamId: string;
  dtmf: {
    track: string;
    digit: string;
    timestamp: string;
  };
}

// --- Plivo REST API types ---

interface PlivoApplication {
  app_id: string;
  app_name: string;
  answer_url: string;
}

interface PlivoListApplicationsResponse {
  objects: PlivoApplication[];
}

// --- Setup config ---

export interface PlivoSetupConfig {
  /** Plivo Auth ID from console.plivo.com */
  authId: string;
  /** Plivo Auth Token from console.plivo.com */
  authToken: string;
  /** The phone number to configure (E.164 format, e.g. "+12025551234") */
  phoneNumber: string;
  /** The public URL of the Worker's /answer endpoint */
  answerUrl: string;
}

// --- Adapter options ---

export interface PlivoAdapterOptions {
  /**
   * Instance name for the VoiceAgent Durable Object.
   * Defaults to the Plivo Call ID (each call gets its own agent instance).
   */
  instanceName?: string;
}

// Energy threshold for speech detection — filters ambient mic noise.
// Mean squared amplitude > 250,000 ≈ RMS > 500 out of ±32,767.
const SPEECH_ENERGY_THRESHOLD = 250_000;

/**
 * Bridges Plivo audio streaming to a VoiceAgent Durable Object.
 */
export class PlivoAdapter {
  /**
   * Configure a Plivo phone number to point to this Worker.
   *
   * Looks for an existing Plivo application whose name starts with
   * "cloudflare-agents-". If found, updates its answer URL. If not,
   * creates a new one. Then assigns the phone number to that application.
   *
   * Call this once during Worker startup or from a /setup endpoint.
   *
   * @example
   * ```typescript
   * await PlivoAdapter.setup({
   *   authId: env.PLIVO_AUTH_ID,
   *   authToken: env.PLIVO_AUTH_TOKEN,
   *   phoneNumber: env.PLIVO_PHONE_NUMBER,
   *   answerUrl: `https://${new URL(request.url).host}/answer`
   * });
   * ```
   */
  static async setup(config: PlivoSetupConfig): Promise<void> {
    const { authId, authToken, phoneNumber, answerUrl } = config;
    const auth = btoa(`${authId}:${authToken}`);
    const base = `https://api.plivo.com/v1/Account/${authId}`;
    const headers = {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    };

    // Find or create application with cloudflare-agents- prefix
    const listResp = await fetch(`${base}/Application/`, { headers });
    if (!listResp.ok) {
      throw new Error(
        `[PlivoAdapter] Failed to list applications: ${listResp.status}`
      );
    }

    const list = (await listResp.json()) as PlivoListApplicationsResponse;
    const existing = list.objects.find((a) =>
      a.app_name.startsWith("cloudflare-agents-")
    );

    let appId: string;

    if (existing) {
      // Update existing application's answer URL
      const updateResp = await fetch(
        `${base}/Application/${existing.app_id}/`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ answer_url: answerUrl, answer_method: "GET" })
        }
      );
      if (!updateResp.ok) {
        throw new Error(
          `[PlivoAdapter] Failed to update application: ${updateResp.status}`
        );
      }
      appId = existing.app_id;
    } else {
      // Create new application
      const createResp = await fetch(`${base}/Application/`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          app_name: `cloudflare-agents-${phoneNumber.replace(/\D/g, "").slice(-4)}`,
          answer_url: answerUrl,
          answer_method: "GET"
        })
      });
      if (!createResp.ok) {
        throw new Error(
          `[PlivoAdapter] Failed to create application: ${createResp.status}`
        );
      }
      const created = (await createResp.json()) as { app_id: string };
      appId = created.app_id;
    }

    // Assign phone number to application
    const number = phoneNumber.replace(/^\+/, "");
    const assignResp = await fetch(`${base}/Number/${number}/`, {
      method: "POST",
      headers,
      body: JSON.stringify({ app_id: appId })
    });
    if (!assignResp.ok) {
      throw new Error(
        `[PlivoAdapter] Failed to assign phone number: ${assignResp.status}`
      );
    }
  }

  /**
   * Handle an incoming Plivo audio streaming WebSocket connection.
   * Routes the audio to a VoiceAgent Durable Object.
   */
  static handleRequest(
    request: Request,
    env: Record<string, unknown>,
    agentName: string,
    options?: PlivoAdapterOptions
  ): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { 0: plivoSocket, 1: serverSocket } = new WebSocketPair();

    serverSocket.accept();

    let streamId: string | null = null;
    let agentSocket: WebSocket | null = null;
    let callId: string | null = null;

    let mediaEncoding = "audio/x-l16";
    let mediaSampleRate = 16000;

    // audioGated prevents sending agent audio to Plivo while the caller
    // is interrupting. Cleared when the pipeline is ready for the next turn.
    let audioGated = false;

    const sendClearAudio = () => {
      if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(JSON.stringify({ event: "clearAudio", streamId }));
      }
    };

    const connectToAgent = async (instanceId: string) => {
      const namespace = env[agentName] as DurableObjectNamespace | undefined;
      if (!namespace) {
        console.error(
          `[PlivoAdapter] DO namespace "${agentName}" not found in env`
        );
        return;
      }

      const id = namespace.idFromName(instanceId);
      const stub = namespace.get(id);

      const agentUrl = new URL(request.url);
      agentUrl.pathname = `/agents/${agentName.toLowerCase()}/${instanceId}`;
      agentUrl.protocol = "https:";

      const agentResp = await stub.fetch(
        new Request(agentUrl.toString(), {
          headers: { Upgrade: "websocket" }
        })
      );

      const ws = agentResp.webSocket;
      if (!ws) {
        console.error("[PlivoAdapter] Failed to get WebSocket from agent");
        return;
      }

      ws.accept();
      agentSocket = ws;

      ws.addEventListener("message", (event) => {
        if (!streamId) return;

        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as Record<string, unknown>;

            if (msg.type === "playback_interrupt") {
              audioGated = true;
              sendClearAudio();
            }

            if (msg.type === "transcript_start") {
              sendClearAudio();
              audioGated = false;
            }

            if (msg.type === "status" && msg.status === "listening") {
              audioGated = false;
            }

            if (
              serverSocket.readyState === WebSocket.OPEN &&
              (msg.type === "transcript" ||
                msg.type === "transcript_end" ||
                msg.type === "status")
            ) {
              serverSocket.send(
                JSON.stringify({
                  event: "checkpoint",
                  streamId,
                  name: JSON.stringify(msg)
                })
              );
            }
          } catch {
            // ignore non-JSON
          }
        } else if (event.data instanceof ArrayBuffer) {
          if (audioGated) return;

          const pcm16k = new Int16Array(event.data);
          let payload: string;
          let outContentType: string;
          let outSampleRate: number;

          if (mediaEncoding.includes("mulaw")) {
            const pcm8k = resamplePCM(pcm16k, 16000, 8000);
            const mulawBytes = new Uint8Array(pcm8k.length);
            for (let i = 0; i < pcm8k.length; i++) {
              mulawBytes[i] = encodeMulaw(pcm8k[i]);
            }
            payload = arrayBufferToBase64(mulawBytes.buffer);
            outContentType = "audio/x-mulaw";
            outSampleRate = 8000;
          } else if (mediaSampleRate === 8000) {
            const pcm8k = resamplePCM(pcm16k, 16000, 8000);
            const buf = new ArrayBuffer(pcm8k.length * 2);
            new Int16Array(buf).set(pcm8k);
            payload = arrayBufferToBase64(buf);
            outContentType = "audio/x-l16";
            outSampleRate = 8000;
          } else {
            payload = arrayBufferToBase64(event.data);
            outContentType = "audio/x-l16";
            outSampleRate = 16000;
          }

          if (serverSocket.readyState === WebSocket.OPEN) {
            serverSocket.send(
              JSON.stringify({
                event: "playAudio",
                media: {
                  contentType: outContentType,
                  sampleRate: outSampleRate,
                  payload
                }
              })
            );
          }
        }
      });

      ws.addEventListener("close", () => {
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.close();
        }
      });

      ws.send(JSON.stringify({ type: "start_call" }));
    };

    serverSocket.addEventListener("message", async (event) => {
      if (typeof event.data !== "string") return;

      let msg: { event: string };
      try {
        msg = JSON.parse(event.data) as { event: string };
      } catch {
        return;
      }

      switch (msg.event) {
        case "start": {
          const startMsg = msg as unknown as PlivoStartMessage;
          streamId = startMsg.start.streamId;
          callId = startMsg.start.callId;
          mediaEncoding = startMsg.start.mediaFormat.encoding;
          mediaSampleRate = startMsg.start.mediaFormat.sampleRate;

          const instanceId = options?.instanceName ?? callId ?? "default";
          await connectToAgent(instanceId);
          break;
        }

        case "media": {
          const mediaMsg = msg as unknown as PlivoMediaMessage;
          if (mediaMsg.media.track !== "inbound") break;

          const raw = base64ToUint8Array(mediaMsg.media.payload);
          let pcm16k: Int16Array;

          if (mediaEncoding.includes("mulaw")) {
            const pcm8k = decodeMulaw(raw);
            pcm16k = resamplePCM(pcm8k, 8000, 16000);
          } else if (mediaSampleRate === 8000) {
            pcm16k = resamplePCM(new Int16Array(raw.buffer), 8000, 16000);
          } else {
            pcm16k = new Int16Array(raw.buffer);
          }

          // Send clearAudio directly on speech detection — no playback
          // window tracking needed since clearAudio is a no-op when
          // nothing is buffered on Plivo's side.
          if (!audioGated) {
            let sumSq = 0;
            for (let i = 0; i < pcm16k.length; i++) {
              sumSq += pcm16k[i] * pcm16k[i];
            }
            if (sumSq / pcm16k.length > SPEECH_ENERGY_THRESHOLD) {
              audioGated = true;
              sendClearAudio();
            }
          }

          if (agentSocket?.readyState === WebSocket.OPEN) {
            const buf = new ArrayBuffer(pcm16k.length * 2);
            new Int16Array(buf).set(pcm16k);
            agentSocket.send(buf);
          }
          break;
        }

        case "dtmf": {
          const dtmfMsg = msg as unknown as PlivoDtmfMessage;
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(JSON.stringify(dtmfMsg));
          }
          break;
        }

        case "clearedAudio": {
          break;
        }

        // Plivo does not send a stop event — call end is detected via
        // WebSocket close.
      }
    });

    serverSocket.addEventListener("close", () => {
      if (agentSocket?.readyState === WebSocket.OPEN) {
        agentSocket.send(JSON.stringify({ type: "end_call" }));
        agentSocket.close();
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: plivoSocket
    });
  }
}
