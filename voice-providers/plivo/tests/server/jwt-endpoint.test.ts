import { afterEach, describe, expect, it, vi } from "vitest";
import { PlivoJWTEndpoint } from "../../src/server/jwt-endpoint.js";

const config = {
  authId: "MA123",
  authToken: "secret-token"
};

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
});

describe("PlivoJWTEndpoint.createToken", () => {
  it("POSTs to the Plivo JWT API with Basic auth", async () => {
    const calls = mockFetch({ body: { token: "jwt-abc" } });
    const endpoint = new PlivoJWTEndpoint(config);

    const token = await endpoint.createToken();

    expect(token).toBe("jwt-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.plivo.com/v1/Account/MA123/JWT/Token/"
    );
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa("MA123:secret-token")}`);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      iss: "MA123"
    });
  });

  it("throws when the Plivo API responds with an error", async () => {
    mockFetch({ ok: false, status: 401 });
    const endpoint = new PlivoJWTEndpoint(config);
    await expect(endpoint.createToken()).rejects.toThrow(
      /Failed to create Plivo JWT: 401/
    );
  });

  it("throws when the response is missing the token field", async () => {
    mockFetch({ body: {} });
    const endpoint = new PlivoJWTEndpoint(config);
    await expect(endpoint.createToken()).rejects.toThrow(/missing token field/);
  });
});

describe("PlivoJWTEndpoint.handleRequest", () => {
  it("rejects unauthenticated requests by default", async () => {
    const endpoint = new PlivoJWTEndpoint(config);
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", { method: "POST" })
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("authorize callback");
  });

  it("issues a token when allowUnauthenticated is true", async () => {
    mockFetch({ body: { token: "jwt-abc" } });
    const endpoint = new PlivoJWTEndpoint({
      ...config,
      allowUnauthenticated: true
    });
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", { method: "POST" })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "jwt-abc" });
  });

  it("returns 403 when the authorize callback rejects", async () => {
    const endpoint = new PlivoJWTEndpoint({
      ...config,
      authorize: () => false
    });
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", { method: "POST" })
    );
    expect(response.status).toBe(403);
  });

  it("issues a token when an async authorize callback accepts", async () => {
    mockFetch({ body: { token: "jwt-abc" } });
    const endpoint = new PlivoJWTEndpoint({
      ...config,
      authorize: async () => true
    });
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", { method: "POST" })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "jwt-abc" });
  });

  it("returns 500 with the error message when token creation fails", async () => {
    mockFetch({ ok: false, status: 503 });
    const endpoint = new PlivoJWTEndpoint({
      ...config,
      allowUnauthenticated: true
    });
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", { method: "POST" })
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("503");
  });

  it("returns 405 for non-POST methods", async () => {
    const endpoint = new PlivoJWTEndpoint({
      ...config,
      allowUnauthenticated: true
    });
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", { method: "GET" })
    );
    expect(response.status).toBe(405);
  });

  it("answers CORS preflight without requiring authorization", async () => {
    const endpoint = new PlivoJWTEndpoint(config);
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", { method: "OPTIONS" })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST"
    );
  });

  it("echoes allowed origins in CORS headers", async () => {
    const endpoint = new PlivoJWTEndpoint({
      ...config,
      allowedOrigins: ["https://app.example.com"]
    });
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", {
        method: "OPTIONS",
        headers: { Origin: "https://app.example.com" }
      })
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com"
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("omits CORS headers for origins not in the allowlist", async () => {
    const endpoint = new PlivoJWTEndpoint({
      ...config,
      allowedOrigins: ["https://app.example.com"]
    });
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.com" }
      })
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
