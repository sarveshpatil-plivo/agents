import { beforeAll, describe, expect, it } from "vitest";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  PlivoAdapter
} from "../src/index.js";

// WebSocketPair and status 101 responses are Cloudflare Workers runtime APIs
// not available in Node/vitest. Minimal stubs so PlivoAdapter can be unit-tested.
class MockWebSocket {
  readyState = 1; // OPEN
  accept() {}
  send(_data: unknown) {}
  close() {}
  addEventListener(_event: string, _handler: unknown) {}
}

beforeAll(() => {
  if (!("WebSocketPair" in globalThis)) {
    (globalThis as unknown as Record<string, unknown>)["WebSocketPair"] =
      class {
        0 = new MockWebSocket();
        1 = new MockWebSocket();
      };
  }

  // Node's Response rejects status 101 (Workers-only). Patch it to accept any status.
  const OriginalResponse = globalThis.Response;
  (globalThis as unknown as Record<string, unknown>)["Response"] =
    class extends OriginalResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        if (init?.status === 101) {
          // Node won't allow 101 — substitute 200 for the purpose of unit tests.
          super(body, { ...init, status: 200 });
        } else {
          super(body, init);
        }
      }
    };
});

describe("PlivoAdapter", () => {
  it("returns 426 when request is not a WebSocket upgrade", () => {
    const request = new Request("https://example.com/plivo");
    const response = PlivoAdapter.handleRequest(request, {}, "MyAgent");
    expect(response.status).toBe(426);
  });

  it("accepts a WebSocket upgrade request", () => {
    const request = new Request("https://example.com/plivo", {
      headers: { Upgrade: "websocket" }
    });
    const response = PlivoAdapter.handleRequest(request, {}, "MyAgent");
    // In Workers runtime the status would be 101; in Node tests we patch Response
    // to allow construction (substituting 200). What matters is it's not an error.
    expect(response.status).not.toBe(426);
    expect(response.status).not.toBeGreaterThanOrEqual(400);
  });
});

describe("base64ToArrayBuffer", () => {
  it("decodes base64 to ArrayBuffer correctly", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const b64 = btoa(String.fromCharCode(...original));
    const result = new Uint8Array(base64ToArrayBuffer(b64));
    expect(result).toEqual(original);
  });
});

describe("arrayBufferToBase64", () => {
  it("encodes ArrayBuffer to base64 correctly", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const b64 = arrayBufferToBase64(original.buffer);
    expect(b64).toBe(btoa(String.fromCharCode(...original)));
  });

  it("round-trips base64 → ArrayBuffer → base64", () => {
    const original = new Uint8Array([10, 20, 30, 40]);
    const b64 = btoa(String.fromCharCode(...original));
    const roundTripped = arrayBufferToBase64(base64ToArrayBuffer(b64));
    expect(roundTripped).toBe(b64);
  });
});
