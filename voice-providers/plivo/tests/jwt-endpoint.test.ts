import { describe, expect, it } from "vitest";
import { PlivoJWTEndpoint } from "../../src/server/jwt-endpoint.js";

const config = {
  authId: "MA123",
  authToken: "secret-token",
  endpointUsername: "browser-endpoint"
};

function decodeSegment(segment: string): Record<string, unknown> {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64)) as Record<string, unknown>;
}

describe("PlivoJWTEndpoint.createToken", () => {
  it("builds a three-part JWT signed HS256 with the plivo content type", async () => {
    const endpoint = new PlivoJWTEndpoint(config);
    const token = await endpoint.createToken();

    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    const header = decodeSegment(parts[0]);
    expect(header).toMatchObject({
      alg: "HS256",
      typ: "JWT",
      cty: "plivo;v=1"
    });
  });

  it("carries the endpoint identity and voice grants", async () => {
    const endpoint = new PlivoJWTEndpoint(config);
    const token = await endpoint.createToken();

    const payload = decodeSegment(token.split(".")[1]);
    expect(payload.iss).toBe("MA123");
    expect(payload.sub).toBe("browser-endpoint");
    expect(payload.grants).toEqual({
      voice: { incoming_allow: true, outgoing_allow: true }
    });
    expect(typeof payload.nbf).toBe("number");
    expect(typeof payload.exp).toBe("number");
  });

  it("clamps the lifetime to Plivo's allowed range", async () => {
    const tooShort = new PlivoJWTEndpoint({ ...config, lifetimeSeconds: 10 });
    const shortPayload = decodeSegment(
      (await tooShort.createToken()).split(".")[1]
    );
    expect((shortPayload.exp as number) - (shortPayload.nbf as number)).toBe(
      180
    );

    const tooLong = new PlivoJWTEndpoint({
      ...config,
      lifetimeSeconds: 999999
    });
    const longPayload = decodeSegment(
      (await tooLong.createToken()).split(".")[1]
    );
    expect((longPayload.exp as number) - (longPayload.nbf as number)).toBe(
      86400
    );
  });

  it("produces a different signature for a different auth token", async () => {
    const a = await new PlivoJWTEndpoint(config).createToken();
    const b = await new PlivoJWTEndpoint({
      ...config,
      authToken: "other-token"
    }).createToken();
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
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
    const endpoint = new PlivoJWTEndpoint({
      ...config,
      allowUnauthenticated: true
    });
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", { method: "POST" })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    expect(body.token.split(".")).toHaveLength(3);
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
    const endpoint = new PlivoJWTEndpoint({
      ...config,
      authorize: async () => true
    });
    const response = await endpoint.handleRequest(
      new Request("https://example.com/api/plivo-token", { method: "POST" })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    expect(body.token.split(".")).toHaveLength(3);
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
