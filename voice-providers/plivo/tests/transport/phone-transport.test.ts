import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceTransport } from "@cloudflare/voice/client";
import type { PlivoCallBridge } from "../../src/providers/call-bridge.js";
import { PlivoPhoneTransport } from "../../src/transport/phone-transport.js";

class MockTransport implements VoiceTransport {
  connected = true;
  sentJSON: Record<string, unknown>[] = [];
  sentBinary: ArrayBuffer[] = [];
  connectCalls = 0;
  disconnectCalls = 0;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;

  sendJSON(data: Record<string, unknown>): void {
    this.sentJSON.push(data);
  }

  sendBinary(data: ArrayBuffer): void {
    this.sentBinary.push(data);
  }

  connect(): void {
    this.connectCalls++;
  }

  disconnect(): void {
    this.disconnectCalls++;
  }
}

function createTransport() {
  const inner = new MockTransport();
  const playAudio = vi.fn();
  const bridge = { playAudio } as unknown as PlivoCallBridge;
  const transport = new PlivoPhoneTransport({ inner, bridge });
  return { inner, transport, playAudio };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PlivoPhoneTransport delegation", () => {
  it("delegates sendJSON, sendBinary, connect, and disconnect", () => {
    const { inner, transport } = createTransport();
    transport.sendJSON({ type: "hello" });
    const buf = new ArrayBuffer(4);
    transport.sendBinary(buf);
    transport.connect();
    transport.disconnect();

    expect(inner.sentJSON).toEqual([{ type: "hello" }]);
    expect(inner.sentBinary).toEqual([buf]);
    expect(inner.connectCalls).toBe(1);
    expect(inner.disconnectCalls).toBe(1);
  });

  it("reflects the inner transport's connected state", () => {
    const { inner, transport } = createTransport();
    expect(transport.connected).toBe(true);
    inner.connected = false;
    expect(transport.connected).toBe(false);
  });

  it("proxies onopen, onclose, and onerror callbacks", () => {
    const { inner, transport } = createTransport();
    const opened = vi.fn();
    const closed = vi.fn();
    const errored = vi.fn();
    transport.onopen = opened;
    transport.onclose = closed;
    transport.onerror = errored;
    transport.connect();

    inner.onopen?.();
    inner.onclose?.();
    inner.onerror?.("boom");

    expect(opened).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(errored).toHaveBeenCalledWith("boom");
  });

  it("forwards messages to onmessage after interception", () => {
    const { inner, transport, playAudio } = createTransport();
    const received: unknown[] = [];
    transport.onmessage = (data) => received.push(data);
    transport.connect();

    const buf = new ArrayBuffer(4);
    inner.onmessage?.("plain text");
    inner.onmessage?.(buf);

    expect(received).toEqual(["plain text", buf]);
    expect(playAudio).toHaveBeenCalledWith(buf);
  });

  it("survives a missing onmessage handler", () => {
    const { inner, transport } = createTransport();
    transport.connect();
    expect(() => inner.onmessage?.("hello")).not.toThrow();
  });
});

describe("PlivoPhoneTransport audio routing", () => {
  it("routes binary audio to the bridge when no format was announced", () => {
    const { inner, transport, playAudio } = createTransport();
    transport.onmessage = () => {};
    transport.connect();

    const buf = new ArrayBuffer(8);
    inner.onmessage?.(buf);

    expect(playAudio).toHaveBeenCalledWith(buf);
  });

  it("routes audio after an explicit pcm16 audio_config", () => {
    const { inner, transport, playAudio } = createTransport();
    transport.onmessage = () => {};
    transport.connect();

    inner.onmessage?.(
      JSON.stringify({ type: "audio_config", format: "pcm16" })
    );
    inner.onmessage?.(new ArrayBuffer(8));

    expect(playAudio).toHaveBeenCalledTimes(1);
  });

  it("drops audio and warns once for non-pcm16 formats", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { inner, transport, playAudio } = createTransport();
    transport.onmessage = () => {};
    transport.connect();

    inner.onmessage?.(JSON.stringify({ type: "audio_config", format: "mp3" }));
    inner.onmessage?.(new ArrayBuffer(8));
    inner.onmessage?.(new ArrayBuffer(8));

    expect(playAudio).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("warns again after the format changes", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { inner, transport } = createTransport();
    transport.onmessage = () => {};
    transport.connect();

    inner.onmessage?.(JSON.stringify({ type: "audio_config", format: "mp3" }));
    inner.onmessage?.(new ArrayBuffer(8));
    inner.onmessage?.(JSON.stringify({ type: "audio_config", format: "ogg" }));
    inner.onmessage?.(new ArrayBuffer(8));

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("converts Blob audio to ArrayBuffer before routing", async () => {
    const { inner, transport, playAudio } = createTransport();
    transport.onmessage = () => {};
    transport.connect();

    inner.onmessage?.(new Blob([new Uint8Array([1, 2, 3, 4])]));
    await tick();

    expect(playAudio).toHaveBeenCalledTimes(1);
    const played = playAudio.mock.calls[0][0] as ArrayBuffer;
    expect(new Uint8Array(played)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("ignores malformed JSON without affecting audio routing", () => {
    const { inner, transport, playAudio } = createTransport();
    transport.onmessage = () => {};
    transport.connect();

    expect(() => inner.onmessage?.("not json")).not.toThrow();
    inner.onmessage?.(new ArrayBuffer(8));
    expect(playAudio).toHaveBeenCalledTimes(1);
  });
});
