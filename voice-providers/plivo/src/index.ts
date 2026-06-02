/**
 * Plivo audio streaming adapter for the Agents voice pipeline.
 *
 * Bridges Plivo's bidirectional audio streaming WebSocket protocol
 * to VoiceAgent's binary PCM + JSON voice protocol.
 *
 * Plivo sends: L16 16kHz base64-encoded audio in JSON messages
 * VoiceAgent expects: 16kHz 16-bit PCM as binary WebSocket frames + JSON control messages
 *
 * This adapter handles:
 * - Decoding base64 L16 16kHz audio from Plivo → forwarding as PCM to VoiceAgent
 * - Encoding VoiceAgent's PCM output → base64 L16 16kHz for Plivo playback
 * - Translating Plivo lifecycle events (start, stop) to VoiceAgent protocol (start_call, end_call)
 * - Forwarding VoiceAgent JSON messages (status, transcript) to the caller via checkpoints
 * - Sending clearAudio to Plivo when the agent is interrupted mid-response
 *
 * Configure your Plivo Answer XML with:
 * ```xml
 * <Response>
 *   <Stream
 *     keepCallAlive="true"
 *     bidirectional="true"
 *     contentType="audio/x-l16;rate=16000"
 *   >wss://your-worker.your-account.workers.dev/plivo</Stream>
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
 * Decode a base64 string to an ArrayBuffer of raw PCM bytes.
 * Plivo sends L16 16kHz audio — no codec conversion needed, just unwrap base64.
 */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

/**
 * Encode an ArrayBuffer of raw PCM bytes to base64.
 * Used when sending agent audio back to Plivo via playAudio.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
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
    payload: string; // base64 L16 PCM
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
   * @param request - The incoming WebSocket upgrade request from Plivo
   * @param env - The Worker environment (must contain the agent's DO namespace)
   * @param agentName - The name of the VoiceAgent DO binding in env (e.g., "MyAgent")
   * @param options - Optional adapter configuration
   *
   * @example
   * ```typescript
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
      agentUrl.protocol = agentUrl.protocol.replace("http", "ws");

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
          // JSON messages from agent — send a checkpoint so Plivo can correlate events.
          // Also send clearAudio on interrupt signals so Plivo stops queued audio.
          try {
            const msg = JSON.parse(event.data) as Record<string, unknown>;

            if (msg.type === "interrupt" || msg.type === "start_of_speech") {
              // Clear any audio Plivo is currently playing — borrowed from Telnyx's
              // interrupt pattern, which Twilio's adapter does not implement.
              if (serverSocket.readyState === WebSocket.OPEN) {
                serverSocket.send(
                  JSON.stringify({ event: "clearAudio", streamId })
                );
              }
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
          // Audio from agent — 16kHz 16-bit mono PCM.
          // Plivo is configured with contentType="audio/x-l16;rate=16000" so
          // no codec conversion is needed — just base64 encode and send.
          const payload = arrayBufferToBase64(event.data);

          if (serverSocket.readyState === WebSocket.OPEN) {
            serverSocket.send(
              JSON.stringify({
                event: "playAudio",
                media: {
                  contentType: "audio/x-l16",
                  sampleRate: "16000",
                  payload
                }
              })
            );
          }
        }
      });

      ws.addEventListener("close", () => {});

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

          const instanceId = options?.instanceName ?? callId ?? "default";
          await connectToAgent(instanceId);
          break;
        }

        case "media": {
          const mediaMsg = msg as unknown as PlivoMediaMessage;
          if (mediaMsg.media.track !== "inbound") break;

          // Decode base64 L16 PCM → send directly to agent as binary.
          // No mulaw decode or resampling needed — Plivo is configured to
          // send 16kHz PCM which is exactly what VoiceAgent expects.
          const pcmBuffer = base64ToArrayBuffer(mediaMsg.media.payload);

          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(pcmBuffer);
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
