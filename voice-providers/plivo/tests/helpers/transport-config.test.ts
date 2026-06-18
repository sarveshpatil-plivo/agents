import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlivoVoiceConfig } from "../../src/helpers/transport-config.js";

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  configs: [] as Record<string, unknown>[]
}));

vi.mock("../../src/providers/call-bridge.js", () => ({
  PlivoCallBridge: class {
    constructor(config: Record<string, unknown>) {
      mocks.configs.push(config);
    }
    stop = mocks.stop;
  }
}));

function mockFetch(spec: {
  ok?: boolean;
  status?: number;
  body?: Record<string, unknown>;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      json: async () => spec.body ?? {}
    });
  };
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.stop.mockClear();
  mocks.configs.length = 0;
});

describe("createPlivoVoiceConfig", () => {
  it("POSTs to the JWT endpoint and builds a bridge from the token", async () => {
    const calls = mockFetch({ body: { token: "jwt-abc" } });

    const setup = await createPlivoVoiceConfig({
      jwtEndpoint: "/api/plivo-token"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/plivo-token");
    expect(calls[0].init?.method).toBe("POST");
    expect(mocks.configs).toEqual([
      { loginToken: "jwt-abc", autoAnswer: undefined, debug: undefined }
    ]);
    expect(setup.audioInput).toBe(setup.bridge);
  });

  it("forwards autoAnswer and debug options to the bridge", async () => {
    mockFetch({ body: { token: "jwt-abc" } });

    await createPlivoVoiceConfig({
      jwtEndpoint: "/api/plivo-token",
      autoAnswer: true,
      debug: true
    });

    expect(mocks.configs).toEqual([
      { loginToken: "jwt-abc", autoAnswer: true, debug: true }
    ]);
  });

  it("stops the bridge on cleanup", async () => {
    mockFetch({ body: { token: "jwt-abc" } });

    const setup = await createPlivoVoiceConfig({
      jwtEndpoint: "/api/plivo-token"
    });
    setup.cleanup();

    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("throws when the JWT endpoint responds with an error", async () => {
    mockFetch({ ok: false, status: 500 });

    await expect(
      createPlivoVoiceConfig({ jwtEndpoint: "/api/plivo-token" })
    ).rejects.toThrow(/Failed to fetch Plivo JWT: 500/);
  });

  it("throws when the response is missing the token", async () => {
    mockFetch({ body: {} });

    await expect(
      createPlivoVoiceConfig({ jwtEndpoint: "/api/plivo-token" })
    ).rejects.toThrow(/missing token/);
  });
});
