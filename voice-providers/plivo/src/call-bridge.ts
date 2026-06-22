import type { VoiceAudioInput } from "@cloudflare/voice/client";
import {
  float32ToInt16,
  computeRMS,
  PCM_CAPTURE_PROCESSOR_SOURCE,
  PCM_PLAYBACK_PROCESSOR_SOURCE
} from "./audio/utils.js";

export interface PlivoCallBridgeConfig {
  /** JWT from the Plivo JWT Token API (generated server-side). */
  loginToken: string;
  /** Automatically answer inbound calls. @default false */
  autoAnswer?: boolean;
  /** Enable Plivo SDK debug logging. @default false */
  debug?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlivoSDK = any;

/**
 * Bridges Plivo WebRTC calls into the Cloudflare voice pipeline.
 *
 * Implements `VoiceAudioInput` from @cloudflare/voice/client — extracts
 * PCM audio from inbound calls and feeds it to the AI pipeline. Also
 * provides `playAudio()` to inject agent responses back into the call.
 *
 * @example
 * ```typescript
 * import { PlivoCallBridge } from "@cloudflare/voice-plivo/browser";
 * import { VoiceClient } from "@cloudflare/voice/client";
 *
 * const bridge = new PlivoCallBridge({ loginToken: jwt, autoAnswer: true });
 * const voiceClient = new VoiceClient({
 *   agent: "my-agent",
 *   audioInput: bridge,
 * });
 * ```
 */
export class PlivoCallBridge implements VoiceAudioInput {
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData?: ((pcm: ArrayBuffer) => void) | null = null;

  private readonly config: PlivoCallBridgeConfig;
  private _connected = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private plivoSdk: PlivoSDK = null;
  private captureContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureWorklet: AudioWorkletNode | null = null;
  private captureBlobUrl: string | null = null;
  private captureAudioEl: HTMLAudioElement | null = null;
  private playbackContext: AudioContext | null = null;
  private playbackWorklet: AudioWorkletNode | null = null;
  private playbackBlobUrl: string | null = null;
  private startPromise: Promise<void> | null = null;
  private finishStart: (() => void) | null = null;
  private startAttempt = 0;
  private mediaSetupAttempt = 0;

  constructor(config: PlivoCallBridgeConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to Plivo and start listening for calls.
   * Returns when login succeeds or throws on failure.
   */
  async start(): Promise<void> {
    if (this._connected) return;
    if (this.startPromise) return this.startPromise;

    const attempt = ++this.startAttempt;

    this.startPromise = new Promise<void>((resolve, reject) => {
      this.finishStart = resolve;
      import("plivo-browser-sdk")
        .then((mod) => {
          const PlivoClass = (
            mod as unknown as {
              default: new (options: Record<string, unknown>) => PlivoSDK;
            }
          ).default;
          this.initSdk(PlivoClass, attempt, resolve, reject);
        })
        .catch(reject);
    }).finally(() => {
      if (this.startAttempt === attempt) {
        this.startPromise = null;
        this.finishStart = null;
      }
    });

    return this.startPromise;
  }

  private initSdk(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PlivoClass: new (options: Record<string, unknown>) => any,
    attempt: number,
    resolve: () => void,
    reject: (reason: unknown) => void
  ): void {
    // stop() may land while the dynamic SDK import is still in flight —
    // don't construct or log in a stale SDK.
    if (this.startAttempt !== attempt) {
      resolve();
      return;
    }
    const sdk = new PlivoClass({
      debug: this.config.debug ? "ALL" : "ERROR",
      permOnClick: false,
      codecs: ["OPUS", "PCMU"],
      enableTracking: false,
      closeProtection: false
    });
    this.plivoSdk = sdk;
    const client = sdk.client;

    client.on("onLogin", () => {
      if (this.startAttempt !== attempt) return resolve();
      this._connected = true;
      resolve();
    });

    client.on("onLoginFailed", (cause: unknown) => {
      if (this.startAttempt !== attempt) return resolve();
      reject(new Error(`Plivo login failed: ${JSON.stringify(cause)}`));
    });

    client.on("onCallAnswered", () => {
      if (this.startAttempt !== attempt) return;
      this.mediaSetupAttempt++;
      this.stopAudioCapture();
      this.stopAudioPlayback();
      const pc = this.getPeerConnection();
      if (pc) {
        this.startAudioCapture(pc, this.mediaSetupAttempt).catch((err) =>
          console.error("[PlivoCallBridge] startAudioCapture failed:", err)
        );
        this.startAudioPlayback(pc, this.mediaSetupAttempt).catch((err) =>
          console.error("[PlivoCallBridge] startAudioPlayback failed:", err)
        );
      }
    });

    client.on("onIncomingCall", () => {
      if (this.startAttempt !== attempt) return;
      if (this.config.autoAnswer) {
        client.answer();
      }
    });

    client.on("onCallTerminated", () => {
      if (this.startAttempt !== attempt) return;
      this.mediaSetupAttempt++;
      this.stopAudioCapture();
      this.stopAudioPlayback();
    });

    client.loginWithAccessToken(this.config.loginToken);
  }

  /** Answer the current inbound call. */
  answer(): void {
    this.plivoSdk?.client?.answer?.();
  }

  /** End the active call. */
  hangup(): void {
    this.plivoSdk?.client?.hangup?.();
  }

  /**
   * Initiate an outbound call via Plivo.
   * @param destination Phone number or SIP URI.
   */
  call(destination: string): void {
    if (!this.plivoSdk) throw new Error("Not connected — call start() first");
    this.plivoSdk.client.call(destination, {});
  }

  clearPlaybackBuffer(): void {
    this.playbackWorklet?.port.postMessage("clear");
  }

  /**
   * Inject PCM audio into the active call (agent → caller).
   * Accepts 16kHz mono Int16 PCM, upsampled to 48kHz for WebRTC.
   */
  playAudio(pcm: ArrayBuffer): void {
    if (!this.playbackWorklet) return;
    const int16 = new Int16Array(pcm);

    const upsampleRatio = 3;
    const float32 = new Float32Array(int16.length * upsampleRatio);
    for (let i = 0; i < int16.length; i++) {
      const current = int16[i] / 32768;
      const next = i < int16.length - 1 ? int16[i + 1] / 32768 : current;
      const base = i * upsampleRatio;
      for (let j = 0; j < upsampleRatio; j++) {
        float32[base + j] = current + (next - current) * (j / upsampleRatio);
      }
    }

    this.playbackWorklet.port.postMessage(float32);
  }

  /** Disconnect from Plivo and clean up all resources. */
  stop(): void {
    this.startAttempt++;
    this.mediaSetupAttempt++;
    // Force-resolve a pending start() so callers never hang when stop()
    // lands mid-login.
    this.finishStart?.();
    this.finishStart = null;
    this.startPromise = null;
    this.stopAudioCapture();
    this.stopAudioPlayback();
    this._connected = false;
    if (this.plivoSdk) {
      try {
        this.plivoSdk.client.logout();
      } catch {
        // ignore
      }
      this.plivoSdk = null;
    }
  }

  private getPeerConnection(): RTCPeerConnection | null {
    try {
      const result = this.plivoSdk?.client?.getPeerConnection?.() as
        | { pc?: RTCPeerConnection }
        | RTCPeerConnection
        | null
        | undefined;
      if (!result) return null;
      if (result instanceof RTCPeerConnection) return result;
      if ("pc" in result && result.pc instanceof RTCPeerConnection) {
        return result.pc;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async startAudioCapture(
    pc: RTCPeerConnection,
    setupAttempt: number
  ): Promise<void> {
    const receivers = pc.getReceivers();
    const audioReceiver = receivers.find(
      (r: RTCRtpReceiver) => r.track?.kind === "audio"
    );
    const track = audioReceiver?.track ?? null;

    if (!track || track.readyState !== "live") {
      console.warn("[PlivoCallBridge] No live audio track — capture skipped");
      return;
    }
    track.enabled = true;

    const remoteStream = new MediaStream([track]);

    const captureAudioEl = document.createElement("audio");
    captureAudioEl.srcObject = remoteStream;
    captureAudioEl.autoplay = true;
    captureAudioEl.volume = 0;
    document.body.appendChild(captureAudioEl);
    try {
      await captureAudioEl.play();
    } catch (e) {
      console.warn("[PlivoCallBridge] audio element play() failed:", e);
    }

    if (track.muted) {
      await new Promise<void>((resolve) => {
        const onUnmute = () => {
          track.removeEventListener("unmute", onUnmute);
          resolve();
        };
        track.addEventListener("unmute", onUnmute);
        setTimeout(() => {
          track.removeEventListener("unmute", onUnmute);
          resolve();
        }, 5000);
      });
    }
    if (this.mediaSetupAttempt !== setupAttempt) {
      captureAudioEl.pause();
      captureAudioEl.srcObject = null;
      captureAudioEl.remove();
      return;
    }

    const captureContext = new AudioContext({ sampleRate: 48000 });
    if (captureContext.state === "suspended") await captureContext.resume();
    if (this.mediaSetupAttempt !== setupAttempt) {
      captureContext.close();
      captureAudioEl.pause();
      captureAudioEl.srcObject = null;
      captureAudioEl.remove();
      return;
    }

    const blob = new Blob([PCM_CAPTURE_PROCESSOR_SOURCE], {
      type: "application/javascript"
    });
    const captureBlobUrl = URL.createObjectURL(blob);
    await captureContext.audioWorklet.addModule(captureBlobUrl);
    if (this.mediaSetupAttempt !== setupAttempt) {
      URL.revokeObjectURL(captureBlobUrl);
      captureContext.close();
      captureAudioEl.pause();
      captureAudioEl.srcObject = null;
      captureAudioEl.remove();
      return;
    }

    const captureSource = captureContext.createMediaStreamSource(remoteStream);
    const captureWorklet = new AudioWorkletNode(
      captureContext,
      "pcm-capture-processor"
    );

    const downsampleRatio = 3;
    captureWorklet.port.onmessage = (event: MessageEvent) => {
      if (!(event.data instanceof Float32Array)) return;
      const raw = event.data;

      const outLen = Math.floor(raw.length / downsampleRatio);
      const float32 = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * downsampleRatio;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, raw.length - 1);
        const frac = srcIdx - idx0;
        float32[i] = raw[idx0] * (1 - frac) + raw[idx1] * frac;
      }

      this.onAudioLevel?.(computeRMS(float32));
      const int16 = float32ToInt16(float32);
      this.onAudioData?.(int16.buffer as ArrayBuffer);
    };

    this.captureAudioEl = captureAudioEl;
    this.captureContext = captureContext;
    this.captureBlobUrl = captureBlobUrl;
    this.captureSource = captureSource;
    this.captureWorklet = captureWorklet;
    captureSource.connect(captureWorklet);
    captureWorklet.connect(captureContext.destination);
  }

  private async startAudioPlayback(
    pc: RTCPeerConnection,
    setupAttempt: number
  ): Promise<void> {
    const playbackContext = new AudioContext({ sampleRate: 48000 });
    if (playbackContext.state === "suspended") await playbackContext.resume();
    if (this.mediaSetupAttempt !== setupAttempt) {
      playbackContext.close();
      return;
    }

    const blob = new Blob([PCM_PLAYBACK_PROCESSOR_SOURCE], {
      type: "application/javascript"
    });
    const playbackBlobUrl = URL.createObjectURL(blob);
    await playbackContext.audioWorklet.addModule(playbackBlobUrl);
    if (this.mediaSetupAttempt !== setupAttempt) {
      URL.revokeObjectURL(playbackBlobUrl);
      playbackContext.close();
      return;
    }

    const playbackWorklet = new AudioWorkletNode(
      playbackContext,
      "pcm-playback-processor"
    );
    const destination = playbackContext.createMediaStreamDestination();

    this.playbackContext = playbackContext;
    this.playbackBlobUrl = playbackBlobUrl;
    this.playbackWorklet = playbackWorklet;
    playbackWorklet.connect(destination);

    const audioTrack = destination.stream.getAudioTracks()[0];
    if (audioTrack) {
      const sender = pc
        .getSenders()
        .find((s: RTCRtpSender) => s.track?.kind === "audio");
      if (sender) {
        await sender.replaceTrack(audioTrack);
      }
    }
  }

  private stopAudioCapture(): void {
    this.captureWorklet?.disconnect();
    this.captureWorklet = null;
    this.captureSource?.disconnect();
    this.captureSource = null;
    this.captureContext?.close();
    this.captureContext = null;
    if (this.captureBlobUrl) {
      URL.revokeObjectURL(this.captureBlobUrl);
      this.captureBlobUrl = null;
    }
    if (this.captureAudioEl) {
      this.captureAudioEl.pause();
      this.captureAudioEl.srcObject = null;
      this.captureAudioEl.remove();
      this.captureAudioEl = null;
    }
  }

  private stopAudioPlayback(): void {
    this.playbackWorklet?.disconnect();
    this.playbackWorklet = null;
    this.playbackContext?.close();
    this.playbackContext = null;
    if (this.playbackBlobUrl) {
      URL.revokeObjectURL(this.playbackBlobUrl);
      this.playbackBlobUrl = null;
    }
  }
}
