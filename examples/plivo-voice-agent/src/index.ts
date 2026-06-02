import { Agent, routeAgentRequest } from "agents";
import {
  withVoice,
  WorkersAITTS,
  WorkersAIFluxSTT,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { PlivoAdapter } from "@cloudflare/voice-plivo";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const VoiceAgent = withVoice(Agent);

const SYSTEM_PROMPT = `You are a helpful voice assistant. Keep your responses concise and conversational — you're being spoken aloud, not read. Aim for 1-3 sentences unless the user asks for more detail.`;

export class MyVoiceAgent extends VoiceAgent<Env> {
  tts = new WorkersAITTS(this.env.AI);
  transcriber = new WorkersAIFluxSTT(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersAi("@cf/zai-org/glm-4.7-flash"),
      system: SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      abortSignal: context.signal
    });

    return result.textStream;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Answer URL — Plivo fetches this when a call comes in
    if (url.pathname === "/answer") {
      const wsUrl = `wss://${url.host}/plivo`;
      const xml = `<Response><Stream keepCallAlive="true" bidirectional="true" contentType="audio/x-l16;rate=16000">${wsUrl}</Stream></Response>`;
      return new Response(xml, {
        headers: { "Content-Type": "application/xml" }
      });
    }

    // Plivo sends WebSocket connections to this path
    if (url.pathname === "/plivo") {
      return PlivoAdapter.handleRequest(
        request,
        env as unknown as Record<string, unknown>,
        "MyVoiceAgent"
      );
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
