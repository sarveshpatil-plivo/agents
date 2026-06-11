import type { VoiceTransport } from "@cloudflare/voice/client";
import type { PlivoCallBridge } from "../providers/call-bridge.js";

export interface PlivoPhoneTransportConfig {
  /**
   * The underlying transport to wrap (e.g. WebSocketVoiceTransport from
   * @cloudflare/voice/client).
   */
  inner: VoiceTransport;
  bridge: PlivoCallBridge;
}

/**
 * Voice transport wrapper that intercepts server audio and routes it
 * to PlivoCallBridge for WebRTC playback.
 *
 * The server-side agent should use `audioFormat: "pcm16"` so the bridge
 * receives 16kHz mono Int16 LE PCM directly, without decoding overhead.
 */
export class PlivoPhoneTransport implements VoiceTransport {
  private inner: VoiceTransport;
  private bridge: PlivoCallBridge;
  private audioFormat: string | null = null;
  private warnedFormat = false;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;

  constructor(config: PlivoPhoneTransportConfig) {
    this.inner = config.inner;
    this.bridge = config.bridge;
  }

  get connected(): boolean {
    return this.inner.connected;
  }

  sendJSON(data: Record<string, unknown>): void {
    this.inner.sendJSON(data);
  }

  sendBinary(data: ArrayBuffer): void {
    this.inner.sendBinary(data);
  }

  connect(): void {
    this.inner.onopen = () => this.onopen?.();
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (err) => this.onerror?.(err);
    this.inner.onmessage = (data) => {
      this.intercept(data);
      this.onmessage?.(data);
    };
    this.inner.connect();
  }

  disconnect(): void {
    this.inner.disconnect();
  }

  private intercept(data: string | ArrayBuffer | Blob): void {
    if (typeof data === "string") {
      this.trackAudioConfig(data);
    } else if (data instanceof ArrayBuffer) {
      this.routeAudio(data);
    } else if (data instanceof Blob) {
      data.arrayBuffer().then((buf) => this.routeAudio(buf));
    }
  }

  private trackAudioConfig(json: string): void {
    try {
      const msg = JSON.parse(json) as { type?: string; format?: string };
      if (msg.type === "audio_config" && msg.format) {
        this.audioFormat = msg.format;
        this.warnedFormat = false;
      }
    } catch {
      /* not JSON */
    }
  }

  private routeAudio(audio: ArrayBuffer): void {
    if (this.audioFormat === "pcm16" || this.audioFormat === null) {
      this.bridge.playAudio(audio);
    } else if (!this.warnedFormat) {
      this.warnedFormat = true;
      console.warn(
        `[PlivoPhoneTransport] Server audio format is "${this.audioFormat}". ` +
          `PlivoCallBridge expects pcm16 (16kHz mono Int16 LE). ` +
          `Set audioFormat: "pcm16" in your server-side VoiceAgentOptions.`
      );
    }
  }
}
