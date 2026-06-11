import { Agent, routeAgentRequest } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { PlivoAdapter } from "@cloudflare/voice-plivo";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const SYSTEM_PROMPT = `You are a helpful voice assistant powered by Cloudflare Workers and Plivo. Keep responses concise and conversational — suitable for a phone call.`;

const VoiceAgent = withVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersAi("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ]
    });

    return result.textStream;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/answer") {
      // Auto-configure the Plivo application and phone number on first call.
      // This is a no-op if the application already exists.
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
