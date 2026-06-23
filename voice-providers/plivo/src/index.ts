/**
 * Plivo audio streaming adapter for the Agents voice pipeline.
 *
 * Bridges Plivo's bidirectional audio streaming WebSocket protocol to
 * VoiceAgent's binary PCM + JSON voice protocol.
 *
 * Plivo sends base64-encoded mulaw 8kHz audio. The adapter decodes mulaw and
 * resamples 8→16kHz before forwarding to VoiceAgent. Agent PCM (16kHz) is
 * resampled back to 8kHz and mulaw-encoded before playback.
 *
 * Use contentType="audio/x-mulaw;rate=8000" in the Plivo Stream XML.
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

import {
  meanSquaredEnergy,
  mulawBase64ToPcm16,
  pcm16ToMulawBase64
} from "./audio/utils.js";
import type {
  PlivoDtmfMessage,
  PlivoMediaMessage,
  PlivoStartMessage
} from "./types.js";

export { setupPlivoApplication, type PlivoSetupConfig } from "./setup.js";
export {
  PlivoJWTEndpoint,
  type PlivoJWTEndpointConfig
} from "./jwt-endpoint.js";

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

    // audioGated suppresses agent audio forwarded to Plivo during an active
    // barge-in. Raised by inbound speech energy detection; cleared
    // automatically when the agent sends its next audio chunk.
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
          if (audioGated) {
            // Discard first chunk after barge-in (may be stale TTS in flight)
            // and clear the gate so subsequent chunks flow through.
            audioGated = false;
            return;
          }

          if (serverSocket.readyState === WebSocket.OPEN) {
            serverSocket.send(
              JSON.stringify({
                event: "playAudio",
                media: {
                  contentType: "audio/x-mulaw",
                  sampleRate: 8000,
                  payload: pcm16ToMulawBase64(new Int16Array(event.data))
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

          const instanceId =
            options?.instanceName ?? startMsg.start.callId ?? "default";
          await connectToAgent(instanceId);
          break;
        }

        case "media": {
          const mediaMsg = msg as unknown as PlivoMediaMessage;
          if (mediaMsg.media.track !== "inbound") break;

          const pcm16k = mulawBase64ToPcm16(mediaMsg.media.payload);

          // Send clearAudio directly on speech detection — no playback
          // window tracking needed since clearAudio is a no-op when
          // nothing is buffered on Plivo's side.
          if (
            !audioGated &&
            meanSquaredEnergy(pcm16k) > SPEECH_ENERGY_THRESHOLD
          ) {
            audioGated = true;
            sendClearAudio();
          }

          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(pcm16k.buffer as ArrayBuffer);
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
