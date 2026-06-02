import { describe, expect, it } from "vitest";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  PlivoAdapter
} from "../src/index.js";

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
    expect(response.status).toBe(101);
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
