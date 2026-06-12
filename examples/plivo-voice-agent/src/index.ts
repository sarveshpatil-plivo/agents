import { Agent, routeAgentRequest, type Connection } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  type TTSProvider,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { PlivoAdapter, PlivoJWTEndpoint } from "@cloudflare/voice-plivo";
import { streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const SYSTEM_PROMPT = `You are a helpful voice assistant powered by Cloudflare Workers and Plivo. Keep responses concise and conversational — suitable for a phone call.

You have tools available:
- get_current_time: Tell the user the current date and time

Use tools when the user's request matches. After calling a tool, incorporate the result naturally into your spoken response.`;

/**
 * Workers AI TTS with raw linear16 PCM output — required for the mulaw
 * encoder in the Plivo adapter. WorkersAITTS defaults to MP3; we call
 * @cf/deepgram/aura-1 directly with encoding + container params.
 */
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
    if (!response.ok) {
      // Returning the error body would ship JSON down the audio pipeline
      // and play as silence — fail loud and skip the audio instead.
      console.error("[PlivoPCMTTS] TTS failed:", await response.text());
      return null;
    }
    return response.arrayBuffer();
  }
}

const VoiceAgent = withVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new PlivoPCMTTS(this.env.AI);

  async onCallStart(connection: Connection) {
    await this.speak(connection, "Hello! How can I help you today?");
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersAi("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      tools: {
        get_current_time: tool({
          description: "Get the current date and time.",
          inputSchema: z.object({}),
          execute: async () => {
            const now = new Date();
            return {
              time: now.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                timeZoneName: "short"
              }),
              date: now.toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric"
              })
            };
          }
        })
      }
    });

    return result.textStream;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/answer") {
      const missing = [
        "PLIVO_AUTH_ID",
        "PLIVO_AUTH_TOKEN",
        "PLIVO_PHONE_NUMBER"
      ].filter((name) => !env[name as keyof Env]);
      if (missing.length > 0) {
        return new Response(
          `Missing Worker secrets: ${missing.join(", ")}. ` +
            `Run: npx wrangler secret bulk .env`,
          { status: 500 }
        );
      }

      try {
        await PlivoAdapter.setup({
          authId: env.PLIVO_AUTH_ID,
          authToken: env.PLIVO_AUTH_TOKEN,
          phoneNumber: env.PLIVO_PHONE_NUMBER,
          answerUrl: `https://${url.host}/answer`
        });
      } catch (err) {
        // A 401 here means the PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN secrets
        // don't match your Plivo account.
        return new Response(
          `Plivo setup failed: ${(err as Error).message}. ` +
            `Check the Worker secrets against console.plivo.com.`,
          { status: 500 }
        );
      }

      const wsUrl = `wss://${url.host}/plivo`;
      const xml = `<Response><Stream keepCallAlive="true" bidirectional="true" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream></Response>`;
      return new Response(xml, {
        headers: { "Content-Type": "application/xml" }
      });
    }

    if (url.pathname === "/plivo") {
      return PlivoAdapter.handleRequest(
        request,
        env as unknown as Record<string, unknown>,
        "MyVoiceAgent"
      );
    }

    if (url.pathname === "/api/plivo-token") {
      const endpoint = new PlivoJWTEndpoint({
        authId: env.PLIVO_AUTH_ID,
        authToken: env.PLIVO_AUTH_TOKEN,
        allowUnauthenticated: true
      });
      return endpoint.handleRequest(request);
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
