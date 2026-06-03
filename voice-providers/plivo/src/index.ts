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
 * This adapter handles:
 * - Decoding inbound Plivo audio → 16kHz PCM for VoiceAgent
 * - Encoding VoiceAgent PCM output → negotiated format for Plivo playback
 * - Translating Plivo lifecycle events (start, WebSocket close) to VoiceAgent protocol (start_call, end_call)
 * - Forwarding VoiceAgent JSON messages (status, transcript) to the caller via checkpoints
 * - Sending clearAudio to Plivo when the agent is interrupted mid-response
 *
 * Configure your Plivo Answer XML with one of:
 * ```xml
 * <Response>
 *   <Stream keepCallAlive="true" bidirectional="true"
 *     contentType="audio/x-l16;rate=16000">wss://your-worker.workers.dev/plivo</Stream>
 * </Response>
 * ```
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

/**
 * Decode a base64 string to a Uint8Array of raw bytes.
 */
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const view = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return view;
}

/**
 * Decode a base64 string to an ArrayBuffer of raw PCM bytes.
 * Exported for use in tests.
 */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const view = base64ToUint8Array(b64);
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer;
}

/**
 * Encode an ArrayBuffer of raw bytes to base64.
 */
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
      encoding: string; // "audio/x-mulaw" | "audio/x-l16"
      sampleRate: number; // 8000 | 16000
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
    payload: string; // base64-encoded audio in negotiated format
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

// --- Adapter ---

export interface PlivoAdapterOptions {
  /**
   * Instance name for the VoiceAgent Durable Object.
   * If not provided, uses the Plivo Call ID (each call gets its own agent instance).
   */
  instanceName?: string;
}

/**
 * Bridges Plivo audio streaming to a VoiceAgent Durable Object.
 *
 * Use `PlivoAdapter.handleRequest()` in your Worker's fetch handler
 * to accept Plivo WebSocket connections and forward them to your VoiceAgent.
 */
export class PlivoAdapter {
  /**
   * Handle an incoming Plivo audio streaming WebSocket connection.
   * Routes the audio to a VoiceAgent Durable Object.
   *
   * The audio format is auto-detected from the `start` event — all three
   * Plivo content types are supported:
   * - `audio/x-l16;rate=16000` (no conversion, lowest latency)
   * - `audio/x-l16;rate=8000`  (resampled to/from 16kHz)
   * - `audio/x-mulaw;rate=8000` (mulaw decoded/encoded + resampled)
   *
   * @param request - The incoming WebSocket upgrade request from Plivo
   * @param env - The Worker environment (must contain the agent's DO namespace)
   * @param agentName - The name of the VoiceAgent DO binding in env (e.g., "MyAgent")
   * @param options - Optional adapter configuration
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

    // Negotiated format from the Plivo start event.
    // Defaults to L16 16kHz (no conversion) until the start event arrives.
    let mediaEncoding = "audio/x-l16";
    let mediaSampleRate = 16000;

    // Barge-in state — hoisted here so both the agent message handler (inside
    // connectToAgent) and the inbound Plivo media handler share the same vars.
    let audioGated = false;
    let playbackEndsAt = 0; // ms timestamp when last queued chunk finishes at Plivo
    let bargingIn = false; // prevents repeated clearAudio for one barge-in event

    const sendClearAudio = () => {
      if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(JSON.stringify({ event: "clearAudio", streamId }));
      }
      playbackEndsAt = 0;
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
              // Pipeline-level barge-in (fires while pipeline is still active).
              audioGated = true;
              bargingIn = true;
              sendClearAudio();
            }

            if (msg.type === "transcript_start") {
              // New speaking turn — flush any stale Plivo buffer and open gate.
              sendClearAudio();
              audioGated = false;
              bargingIn = false;
            }

            // Safety net: pipeline fully done and agent is listening again.
            // Ensure gate is open so the next turn can play audio.
            if (
              msg.type === "status" &&
              (msg as Record<string, unknown>).status === "listening"
            ) {
              audioGated = false;
              bargingIn = false;
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
          // Audio from agent — always 16kHz 16-bit mono PCM.
          // Convert to the format negotiated with Plivo before sending.
          if (audioGated) return;

          const pcm16k = new Int16Array(event.data);
          let payload: string;
          let outContentType: string;
          let outSampleRate: number;

          if (mediaEncoding.includes("mulaw")) {
            // L16 16kHz → L16 8kHz → mulaw 8kHz
            const pcm8k = resamplePCM(pcm16k, 16000, 8000);
            const mulawBytes = new Uint8Array(pcm8k.length);
            for (let i = 0; i < pcm8k.length; i++) {
              mulawBytes[i] = encodeMulaw(pcm8k[i]);
            }
            payload = arrayBufferToBase64(mulawBytes.buffer);
            outContentType = "audio/x-mulaw";
            outSampleRate = 8000;
          } else if (mediaSampleRate === 8000) {
            // L16 16kHz → L16 8kHz
            const pcm8k = resamplePCM(pcm16k, 16000, 8000);
            const buf = new ArrayBuffer(pcm8k.length * 2);
            new Int16Array(buf).set(pcm8k);
            payload = arrayBufferToBase64(buf);
            outContentType = "audio/x-l16";
            outSampleRate = 8000;
          } else {
            // L16 16kHz → no conversion
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

            // Accumulate estimated playback duration so adapter-side barge-in
            // detection works even after the voice pipeline has finished.
            // outSampleRate samples/s × 2 bytes/sample → bytes per second.
            const chunkSamples =
              outContentType === "audio/x-mulaw"
                ? (payload.length * 3) / 4 // base64 → bytes, 1 byte/sample
                : (payload.length * 3) / 4 / 2; // base64 → bytes, 2 bytes/sample
            const chunkMs = (chunkSamples / outSampleRate) * 1000;
            playbackEndsAt =
              Date.now() < playbackEndsAt
                ? playbackEndsAt + chunkMs
                : Date.now() + chunkMs;
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

          // Read the negotiated audio format — used for all subsequent
          // inbound decode and outbound encode decisions.
          mediaEncoding = startMsg.start.mediaFormat.encoding;
          mediaSampleRate = startMsg.start.mediaFormat.sampleRate;

          const instanceId = options?.instanceName ?? callId ?? "default";
          await connectToAgent(instanceId);
          break;
        }

        case "media": {
          const mediaMsg = msg as unknown as PlivoMediaMessage;
          if (mediaMsg.media.track !== "inbound") break;

          // Adapter-side barge-in: if Plivo is still playing buffered audio
          // and the caller sends audio, clear the buffer immediately. This
          // catches the common case where the voice pipeline already finished
          // sending chunks (and is no longer "active") while Plivo is still
          // playing them — so playback_interrupt never fires from VoiceAgent.
          if (!bargingIn && Date.now() < playbackEndsAt) {
            bargingIn = true;
            audioGated = true;
            sendClearAudio();
          }

          // Decode inbound audio to 16kHz 16-bit PCM regardless of
          // the negotiated format, so VoiceAgent always receives PCM 16kHz.
          const raw = base64ToUint8Array(mediaMsg.media.payload);
          let pcm16k: Int16Array;

          if (mediaEncoding.includes("mulaw")) {
            // mulaw 8kHz → L16 8kHz → L16 16kHz
            const pcm8k = decodeMulaw(raw);
            pcm16k = resamplePCM(pcm8k, 8000, 16000);
          } else if (mediaSampleRate === 8000) {
            // L16 8kHz → L16 16kHz
            pcm16k = resamplePCM(new Int16Array(raw.buffer), 8000, 16000);
          } else {
            // L16 16kHz — no conversion
            pcm16k = new Int16Array(raw.buffer);
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

        // Plivo does not send a stop event — call end is signaled by
        // the WebSocket closing (handled in the close listener below).
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
