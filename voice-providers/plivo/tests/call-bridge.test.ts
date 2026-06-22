import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlivoCallBridge } from "../src/call-bridge.js";

type EventHandler = (arg?: unknown) => void;

interface MockPlivoClient {
  on: ReturnType<typeof vi.fn>;
  loginWithAccessToken: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  answer: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  getPeerConnection: ReturnType<typeof vi.fn>;
}

interface MockPlivoModule {
  default: ReturnType<typeof vi.fn>;
  __mockClient: MockPlivoClient;
}

vi.mock("plivo-browser-sdk", () => {
  const mockClient = {
    on: vi.fn(),
    loginWithAccessToken: vi.fn(),
    logout: vi.fn(),
    answer: vi.fn(),
    hangup: vi.fn(),
    call: vi.fn(),
    getPeerConnection: vi.fn()
  };

  return {
    default: vi.fn(function () {
      return { client: mockClient };
    }),
    __mockClient: mockClient
  };
});

async function getMockPlivo(): Promise<MockPlivoModule> {
  return (await import("plivo-browser-sdk")) as unknown as MockPlivoModule;
}

function captureHandlers(
  client: MockPlivoClient
): Record<string, EventHandler> {
  const handlers: Record<string, EventHandler> = {};
  client.on.mockImplementation((event: string, cb: EventHandler) => {
    handlers[event] = cb;
  });
  return handlers;
}

/**
 * Drives a bridge through start() to a successful login. The SDK is
 * loaded via a dynamic import, so event handlers appear asynchronously.
 */
async function startBridge(
  bridge: PlivoCallBridge,
  client: MockPlivoClient
): Promise<Record<string, EventHandler>> {
  const handlers = captureHandlers(client);
  const startPromise = bridge.start();
  await vi.waitFor(() => {
    expect(handlers.onLogin).toBeDefined();
  });
  handlers.onLogin?.();
  await startPromise;
  return handlers;
}

interface MockTrack {
  kind: string;
  readyState: string;
  enabled: boolean;
  muted: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

interface MockSender {
  track: { kind: string };
  replaceTrack: ReturnType<typeof vi.fn>;
}

function mockTrack(): MockTrack {
  return {
    kind: "audio",
    readyState: "live",
    enabled: true,
    muted: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
}

/** Stands in for the global RTCPeerConnection so instanceof checks pass. */
class FakeRTCPeerConnection {
  private readonly receivers: { track: MockTrack }[];
  private readonly senders: MockSender[];

  constructor(receivers: { track: MockTrack }[], senders: MockSender[]) {
    this.receivers = receivers;
    this.senders = senders;
  }

  getReceivers(): { track: MockTrack }[] {
    return this.receivers;
  }

  getSenders(): MockSender[] {
    return this.senders;
  }
}

describe("PlivoCallBridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("config and interface", () => {
    it("creates with a login token", () => {
      expect(new PlivoCallBridge({ loginToken: "test-jwt" })).toBeDefined();
    });

    it("accepts optional config overrides", () => {
      expect(
        new PlivoCallBridge({
          loginToken: "test-jwt",
          autoAnswer: true,
          debug: true
        })
      ).toBeDefined();
    });

    it("exposes connected as false initially", () => {
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      expect(bridge.connected).toBe(false);
    });

    it("implements the VoiceAudioInput interface shape", () => {
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      expect(bridge.onAudioLevel).toBeNull();
      expect(bridge.onAudioData).toBeNull();
      expect(typeof bridge.start).toBe("function");
      expect(typeof bridge.stop).toBe("function");
      expect(typeof bridge.playAudio).toBe("function");
      expect(typeof bridge.answer).toBe("function");
      expect(typeof bridge.hangup).toBe("function");
      expect(typeof bridge.call).toBe("function");
      expect(typeof bridge.clearPlaybackBuffer).toBe("function");
    });
  });

  describe("start lifecycle", () => {
    beforeEach(async () => {
      await getMockPlivo();
      vi.clearAllMocks();
    });

    it("constructs the SDK with debug ERROR by default", async () => {
      const mod = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      await startBridge(bridge, mod.__mockClient);

      expect(mod.default).toHaveBeenCalledWith(
        expect.objectContaining({ debug: "ERROR", permOnClick: false })
      );
    });

    it("constructs the SDK with debug ALL when config.debug is true", async () => {
      const mod = await getMockPlivo();
      const bridge = new PlivoCallBridge({
        loginToken: "test-jwt",
        debug: true
      });

      await startBridge(bridge, mod.__mockClient);

      expect(mod.default).toHaveBeenCalledWith(
        expect.objectContaining({ debug: "ALL" })
      );
    });

    it("logs in with the configured access token", async () => {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "my-token" });

      await startBridge(bridge, __mockClient);

      expect(__mockClient.loginWithAccessToken).toHaveBeenCalledWith(
        "my-token"
      );
    });

    it("resolves start and sets connected when onLogin fires", async () => {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      await startBridge(bridge, __mockClient);

      expect(bridge.connected).toBe(true);
    });

    it("rejects start when onLoginFailed fires", async () => {
      const { __mockClient } = await getMockPlivo();
      const handlers = captureHandlers(__mockClient);
      const bridge = new PlivoCallBridge({ loginToken: "bad-jwt" });

      const startPromise = bridge.start();
      await vi.waitFor(() => {
        expect(handlers.onLoginFailed).toBeDefined();
      });
      handlers.onLoginFailed?.({ code: 401 });

      await expect(startPromise).rejects.toThrow("Plivo login failed");
      expect(bridge.connected).toBe(false);
    });

    it("shares one login attempt across concurrent start calls", async () => {
      const mod = await getMockPlivo();
      const handlers = captureHandlers(mod.__mockClient);
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      // start() is async, so callers get distinct wrapper promises, but
      // both settle from the same underlying startPromise and login.
      const first = bridge.start();
      const second = bridge.start();

      await vi.waitFor(() => {
        expect(handlers.onLogin).toBeDefined();
      });
      handlers.onLogin?.();
      await Promise.all([first, second]);

      expect(bridge.connected).toBe(true);

      expect(mod.default).toHaveBeenCalledTimes(1);
      expect(mod.__mockClient.loginWithAccessToken).toHaveBeenCalledTimes(1);
    });

    it("treats start as a no-op once connected", async () => {
      const mod = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });
      await startBridge(bridge, mod.__mockClient);

      await bridge.start();

      expect(mod.default).toHaveBeenCalledTimes(1);
      expect(mod.__mockClient.loginWithAccessToken).toHaveBeenCalledTimes(1);
    });
  });

  describe("stop and the stop-during-login race", () => {
    beforeEach(async () => {
      await getMockPlivo();
      vi.clearAllMocks();
    });

    it("resolves a pending start when stop lands mid-login", async () => {
      const { __mockClient } = await getMockPlivo();
      const handlers = captureHandlers(__mockClient);
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      const startPromise = bridge.start();
      await vi.waitFor(() => {
        expect(__mockClient.loginWithAccessToken).toHaveBeenCalled();
      });
      // onLogin never fires — stop() must still settle the promise.
      expect(handlers.onLogin).toBeDefined();
      bridge.stop();

      const outcome = await Promise.race([
        startPromise.then(() => "resolved"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("timed out"), 1000);
        })
      ]);
      expect(outcome).toBe("resolved");
      expect(bridge.connected).toBe(false);
      expect(__mockClient.logout).toHaveBeenCalled();
    });

    it("never constructs the SDK when stop lands before the import resolves", async () => {
      const mod = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      // stop() synchronously, before the dynamic import microtask runs.
      const startPromise = bridge.start();
      bridge.stop();
      await startPromise;

      expect(mod.default).not.toHaveBeenCalled();
      expect(mod.__mockClient.loginWithAccessToken).not.toHaveBeenCalled();
      expect(bridge.connected).toBe(false);
    });

    it("ignores a stale onLogin that fires after stop", async () => {
      const { __mockClient } = await getMockPlivo();
      const handlers = captureHandlers(__mockClient);
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      const startPromise = bridge.start();
      await vi.waitFor(() => {
        expect(handlers.onLogin).toBeDefined();
      });
      bridge.stop();
      handlers.onLogin?.();
      await startPromise;

      expect(bridge.connected).toBe(false);
    });

    it("disconnects and logs out after a successful start", async () => {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });
      await startBridge(bridge, __mockClient);

      bridge.stop();

      expect(bridge.connected).toBe(false);
      expect(__mockClient.logout).toHaveBeenCalled();
    });

    it("allows a fresh start after stop", async () => {
      const mod = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });
      await startBridge(bridge, mod.__mockClient);
      bridge.stop();

      await startBridge(bridge, mod.__mockClient);

      expect(bridge.connected).toBe(true);
      expect(mod.default).toHaveBeenCalledTimes(2);
    });

    it("is safe to call without start", () => {
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      expect(() => bridge.stop()).not.toThrow();
      expect(bridge.connected).toBe(false);
    });
  });

  describe("incoming calls", () => {
    beforeEach(async () => {
      await getMockPlivo();
      vi.clearAllMocks();
    });

    it("answers automatically when autoAnswer is true", async () => {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({
        loginToken: "test-jwt",
        autoAnswer: true
      });
      const handlers = await startBridge(bridge, __mockClient);

      handlers.onIncomingCall?.();

      expect(__mockClient.answer).toHaveBeenCalledTimes(1);
    });

    it("does not answer automatically when autoAnswer is false", async () => {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({
        loginToken: "test-jwt",
        autoAnswer: false
      });
      const handlers = await startBridge(bridge, __mockClient);

      handlers.onIncomingCall?.();

      expect(__mockClient.answer).not.toHaveBeenCalled();
    });
  });

  describe("call actions", () => {
    beforeEach(async () => {
      await getMockPlivo();
      vi.clearAllMocks();
    });

    it("answer delegates to the client", async () => {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });
      await startBridge(bridge, __mockClient);

      bridge.answer();

      expect(__mockClient.answer).toHaveBeenCalledTimes(1);
    });

    it("hangup delegates to the client", async () => {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });
      await startBridge(bridge, __mockClient);

      bridge.hangup();

      expect(__mockClient.hangup).toHaveBeenCalledTimes(1);
    });

    it("answer and hangup are safe no-ops before start", async () => {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      expect(() => bridge.answer()).not.toThrow();
      expect(() => bridge.hangup()).not.toThrow();
      expect(__mockClient.answer).not.toHaveBeenCalled();
      expect(__mockClient.hangup).not.toHaveBeenCalled();
    });

    it("call throws before start", () => {
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      expect(() => bridge.call("+18005551234")).toThrow("Not connected");
    });

    it("call delegates to the client after login", async () => {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });
      await startBridge(bridge, __mockClient);

      bridge.call("+18005551234");

      expect(__mockClient.call).toHaveBeenCalledWith("+18005551234", {});
    });
  });

  describe("media setup and audio paths", () => {
    interface MockWorkletPort {
      onmessage: ((event: MessageEvent) => void) | null;
      postMessage: ReturnType<typeof vi.fn>;
    }

    interface MockWorkletNode {
      port: MockWorkletPort;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }

    interface MockAudioElement {
      srcObject: unknown;
      autoplay: boolean;
      volume: number;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    }

    interface MockAudioContext {
      state: string;
      sampleRate: number;
      destination: Record<string, never>;
      resume: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      audioWorklet: { addModule: ReturnType<typeof vi.fn> };
      createMediaStreamSource: ReturnType<typeof vi.fn>;
      createMediaStreamDestination: ReturnType<typeof vi.fn>;
    }

    let captureNode: MockWorkletNode;
    let playbackNode: MockWorkletNode;
    let createdContexts: MockAudioContext[];
    let audioElements: MockAudioElement[];
    let appendChild: ReturnType<typeof vi.fn>;
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;
    const playbackTrack = { kind: "audio", id: "playback-track" };

    function makeWorkletNode(): MockWorkletNode {
      return {
        port: { onmessage: null, postMessage: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn()
      };
    }

    beforeEach(async () => {
      await getMockPlivo();
      vi.clearAllMocks();

      captureNode = makeWorkletNode();
      playbackNode = makeWorkletNode();
      createdContexts = [];
      audioElements = [];
      appendChild = vi.fn();
      createObjectURL = vi.fn(() => "blob:mock-url");
      revokeObjectURL = vi.fn();

      vi.stubGlobal(
        "AudioContext",
        vi.fn(function () {
          const context: MockAudioContext = {
            state: "running",
            sampleRate: 48000,
            destination: {},
            resume: vi.fn().mockResolvedValue(undefined),
            close: vi.fn(),
            audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
            createMediaStreamSource: vi.fn(() => ({
              connect: vi.fn(),
              disconnect: vi.fn()
            })),
            createMediaStreamDestination: vi.fn(() => ({
              stream: { getAudioTracks: () => [playbackTrack] }
            }))
          };
          createdContexts.push(context);
          return context;
        })
      );
      vi.stubGlobal(
        "AudioWorkletNode",
        vi.fn(function (_context: unknown, name: string) {
          return name === "pcm-capture-processor" ? captureNode : playbackNode;
        })
      );
      vi.stubGlobal(
        "MediaStream",
        vi.fn(function () {
          return {};
        })
      );
      vi.stubGlobal(
        "Blob",
        vi.fn(function () {})
      );
      vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
      vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
      vi.stubGlobal("document", {
        createElement: vi.fn(() => {
          const el: MockAudioElement = {
            srcObject: null,
            autoplay: false,
            volume: 1,
            play: vi.fn().mockResolvedValue(undefined),
            pause: vi.fn(),
            remove: vi.fn()
          };
          audioElements.push(el);
          return el;
        }),
        body: { appendChild }
      });
    });

    async function setupMedia(options?: {
      muted?: boolean;
      wrapPc?: boolean;
    }): Promise<{
      bridge: PlivoCallBridge;
      handlers: Record<string, EventHandler>;
      track: MockTrack;
      sender: MockSender;
    }> {
      const { __mockClient } = await getMockPlivo();
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });
      const handlers = await startBridge(bridge, __mockClient);

      const track = mockTrack();
      if (options?.muted) track.muted = true;
      const sender: MockSender = {
        track: { kind: "audio" },
        replaceTrack: vi.fn().mockResolvedValue(undefined)
      };
      const pc = new FakeRTCPeerConnection([{ track }], [sender]);
      __mockClient.getPeerConnection.mockReturnValue(
        options?.wrapPc ? { pc } : pc
      );

      handlers.onCallAnswered?.();
      return { bridge, handlers, track, sender };
    }

    async function waitForMediaReady(): Promise<void> {
      await vi.waitFor(() => {
        expect(captureNode.port.onmessage).not.toBeNull();
        expect(playbackNode.connect).toHaveBeenCalled();
      });
    }

    it("wires capture and playback when onCallAnswered fires", async () => {
      await setupMedia();
      await waitForMediaReady();

      expect(AudioContext).toHaveBeenCalledTimes(2);
      expect(AudioContext).toHaveBeenCalledWith({ sampleRate: 48000 });
      for (const context of createdContexts) {
        expect(context.audioWorklet.addModule).toHaveBeenCalledWith(
          "blob:mock-url"
        );
      }
      expect(AudioWorkletNode).toHaveBeenCalledWith(
        expect.anything(),
        "pcm-capture-processor"
      );
      expect(AudioWorkletNode).toHaveBeenCalledWith(
        expect.anything(),
        "pcm-playback-processor"
      );
      expect(captureNode.connect).toHaveBeenCalled();
    });

    it("plays the remote track through a muted audio element", async () => {
      await setupMedia();
      await waitForMediaReady();

      expect(document.createElement).toHaveBeenCalledWith("audio");
      expect(audioElements).toHaveLength(1);
      const el = audioElements[0];
      expect(appendChild).toHaveBeenCalledWith(el);
      expect(el.play).toHaveBeenCalled();
      expect(el.autoplay).toBe(true);
      expect(el.volume).toBe(0);
    });

    it("replaces the sender track with the playback stream track", async () => {
      const { sender } = await setupMedia();

      await vi.waitFor(() => {
        expect(sender.replaceTrack).toHaveBeenCalledWith(playbackTrack);
      });
    });

    it("unwraps a { pc } result from getPeerConnection", async () => {
      await setupMedia({ wrapPc: true });

      await waitForMediaReady();
    });

    it("waits for a muted track to unmute before capturing", async () => {
      const { track } = await setupMedia({ muted: true });

      await vi.waitFor(() => {
        expect(track.addEventListener).toHaveBeenCalledWith(
          "unmute",
          expect.any(Function)
        );
      });
      expect(captureNode.port.onmessage).toBeNull();

      const unmuteHandler = track.addEventListener.mock.calls.find(
        (call) => call[0] === "unmute"
      )?.[1] as (() => void) | undefined;
      unmuteHandler?.();

      await waitForMediaReady();
    });

    it("calls onAudioLevel and onAudioData from capture port messages", async () => {
      const { bridge } = await setupMedia();
      await waitForMediaReady();
      const audioLevelSpy = vi.fn();
      const audioDataSpy = vi.fn();
      bridge.onAudioLevel = audioLevelSpy;
      bridge.onAudioData = audioDataSpy;

      captureNode.port.onmessage?.({
        data: new Float32Array(12).fill(0.5)
      } as MessageEvent);

      expect(audioLevelSpy).toHaveBeenCalledTimes(1);
      expect(audioLevelSpy.mock.calls[0]?.[0]).toBeCloseTo(0.5, 5);
      expect(audioDataSpy).toHaveBeenCalledTimes(1);
      const pcm = audioDataSpy.mock.calls[0]?.[0] as ArrayBuffer;
      expect(pcm).toBeInstanceOf(ArrayBuffer);
      const int16 = new Int16Array(pcm);
      expect(int16).toHaveLength(4);
      for (const sample of int16) {
        expect(sample).toBe(16383);
      }
    });

    it("ignores capture port messages that are not Float32Array", async () => {
      const { bridge } = await setupMedia();
      await waitForMediaReady();
      const audioLevelSpy = vi.fn();
      const audioDataSpy = vi.fn();
      bridge.onAudioLevel = audioLevelSpy;
      bridge.onAudioData = audioDataSpy;

      captureNode.port.onmessage?.({ data: "not-audio" } as MessageEvent);

      expect(audioLevelSpy).not.toHaveBeenCalled();
      expect(audioDataSpy).not.toHaveBeenCalled();
    });

    it("playAudio is a no-op before playback is wired", () => {
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      expect(() =>
        bridge.playAudio(new Int16Array([100, -100]).buffer)
      ).not.toThrow();
      expect(playbackNode.port.postMessage).not.toHaveBeenCalled();
    });

    it("playAudio upsamples 16kHz Int16 to 48kHz Float32", async () => {
      const { bridge } = await setupMedia();
      await waitForMediaReady();

      bridge.playAudio(new Int16Array([16384, -16384]).buffer);

      expect(playbackNode.port.postMessage).toHaveBeenCalledTimes(1);
      const posted = playbackNode.port.postMessage.mock.calls[0]?.[0] as
        | Float32Array
        | undefined;
      expect(posted).toBeInstanceOf(Float32Array);
      const samples = posted as Float32Array;
      expect(samples).toHaveLength(6);
      expect(samples[0]).toBeCloseTo(0.5, 5);
      expect(samples[5]).toBeCloseTo(-0.5, 5);
      for (const sample of samples) {
        expect(Math.abs(sample)).toBeLessThanOrEqual(1);
      }
    });

    it("clearPlaybackBuffer posts clear to the playback worklet", async () => {
      const { bridge } = await setupMedia();
      await waitForMediaReady();

      bridge.clearPlaybackBuffer();

      expect(playbackNode.port.postMessage).toHaveBeenCalledWith("clear");
    });

    it("clearPlaybackBuffer is a no-op before playback is wired", () => {
      const bridge = new PlivoCallBridge({ loginToken: "test-jwt" });

      expect(() => bridge.clearPlaybackBuffer()).not.toThrow();
      expect(playbackNode.port.postMessage).not.toHaveBeenCalled();
    });

    it("tears down capture and playback on onCallTerminated", async () => {
      const { bridge, handlers } = await setupMedia();
      await waitForMediaReady();

      handlers.onCallTerminated?.();

      expect(captureNode.disconnect).toHaveBeenCalled();
      expect(playbackNode.disconnect).toHaveBeenCalled();
      for (const context of createdContexts) {
        expect(context.close).toHaveBeenCalled();
      }
      expect(revokeObjectURL).toHaveBeenCalledTimes(2);
      expect(audioElements[0]?.pause).toHaveBeenCalled();
      expect(audioElements[0]?.remove).toHaveBeenCalled();

      bridge.playAudio(new Int16Array([100]).buffer);
      expect(playbackNode.port.postMessage).not.toHaveBeenCalled();
    });

    it("tears down media on stop", async () => {
      const { bridge } = await setupMedia();
      await waitForMediaReady();

      bridge.stop();

      expect(captureNode.disconnect).toHaveBeenCalled();
      expect(playbackNode.disconnect).toHaveBeenCalled();
      expect(audioElements[0]?.remove).toHaveBeenCalled();
    });
  });
});
