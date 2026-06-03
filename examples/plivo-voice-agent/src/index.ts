import { Agent, type Connection, routeAgentRequest } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  type VoiceTurnContext,
  type TextSource,
  type TTSProvider,
  type StreamingTTSProvider
} from "@cloudflare/voice";
import { PlivoAdapter } from "@cloudflare/voice-plivo";

// Resample PCM audio from one sample rate to another using linear interpolation.
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

// OpenAI TTS — non-streaming fallback (used by speak()).
// Streaming path (used by onTurn) goes through synthesizeStream.
class OpenAITTS implements TTSProvider, StreamingTTSProvider {
  #apiKey: string;
  #voice: string;

  constructor(apiKey: string, voice = "alloy") {
    this.#apiKey = apiKey;
    this.#voice = voice;
  }

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice: this.#voice,
        response_format: "pcm"
      }),
      signal
    });

    if (!resp.ok) {
      console.error(`[OpenAITTS] ${resp.status}: ${await resp.text()}`);
      return null;
    }

    const raw = await resp.arrayBuffer();
    const pcm24k = new Int16Array(raw);
    const pcm16k = resamplePCM(pcm24k, 24000, 16000);
    const out = new ArrayBuffer(pcm16k.length * 2);
    new Int16Array(out).set(pcm16k);
    return out;
  }

  // Streaming variant — yields ~150ms PCM chunks so the voice pipeline can
  // send them one at a time. This lets clearAudio cut off mid-response when
  // the caller interrupts, rather than waiting for the full audio to finish.
  async *synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer> {
    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice: this.#voice,
        response_format: "pcm"
      }),
      signal
    });

    if (!resp.ok || !resp.body) {
      console.error(`[OpenAITTS stream] ${resp.status}`);
      return;
    }

    const reader = resp.body.getReader();
    // Accumulate ~150ms worth of 24kHz 16-bit samples (2400 samples = 4800 bytes)
    // before yielding, so Plivo gets a steady stream of small chunks.
    const CHUNK_BYTES = 4800;
    let acc = new Uint8Array(CHUNK_BYTES);
    let accLen = 0;

    const flush = (len: number): ArrayBuffer => {
      const pcm24k = new Int16Array(acc.buffer, 0, len / 2);
      const pcm16k = resamplePCM(pcm24k, 24000, 16000);
      const out = new ArrayBuffer(pcm16k.length * 2);
      new Int16Array(out).set(pcm16k);
      return out;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) return;

      let pos = 0;
      while (pos < value.length) {
        const space = CHUNK_BYTES - accLen;
        const toCopy = Math.min(space, value.length - pos);
        acc.set(value.subarray(pos, pos + toCopy), accLen);
        accLen += toCopy;
        pos += toCopy;

        if (accLen === CHUNK_BYTES) {
          yield flush(accLen);
          accLen = 0;
        }
      }
    }

    if (accLen > 0) yield flush(accLen);
  }
}

const VoiceAgent = withVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  tts = new OpenAITTS(this.env.OPENAI_API_KEY);
  transcriber = new WorkersAIFluxSTT(this.env.AI, { eotThreshold: 0.6 });

  async onCallStart(connection: Connection) {
    await this.speak(
      connection,
      "Hello! I am your Plivo voice assistant. How can I help you today?"
    );
  }

  async onTurn(
    transcript: string,
    _context: VoiceTurnContext
  ): Promise<TextSource> {
    // Return the streaming LLM response directly so the voice pipeline
    // uses synthesizeStream and sends audio in chunks — enabling barge-in.
    return this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        {
          role: "system",
          content:
            "You are a helpful voice assistant. Respond conversationally in 3-5 sentences."
        },
        { role: "user", content: transcript }
      ],
      stream: true
    }) as unknown as ReadableStream<Uint8Array>;
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
