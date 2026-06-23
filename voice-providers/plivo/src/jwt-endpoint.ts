/**
 * Server-side JWT endpoint for Plivo WebRTC authentication.
 *
 * Mints a short-lived Plivo access token so the browser can register as a
 * WebRTC endpoint and place/receive calls without ever seeing the auth
 * token. Mount `handleRequest` in a Cloudflare Worker route (e.g.
 * `/api/plivo-token`).
 *
 * The token is generated and signed locally (HS256 with the auth token),
 * the same way Plivo's own server SDKs build it — so it carries the
 * endpoint identity (`sub`) and the voice grants the browser SDK needs to
 * place calls. The auth token is used only as the signing key and never
 * leaves the Worker.
 *
 * Configure an `authorize` callback (recommended) before mounting in a
 * public Worker. For local demos only, set `allowUnauthenticated: true`.
 */

export interface PlivoJWTEndpointConfig {
  /** Plivo Auth ID from console.plivo.com */
  authId: string;
  /** Plivo Auth Token from console.plivo.com (server-side secret — never send to browser). */
  authToken: string;
  /**
   * Username of the Plivo WebRTC endpoint this token logs in as. Create one
   * with the Create Endpoint API (or in the console) — it becomes the JWT
   * `sub` claim. Without it Plivo rejects the token with
   * INVALID_ACCESS_TOKEN_GRANTS.
   */
  endpointUsername: string;
  /**
   * Token lifetime in seconds. Plivo allows 180–86400. @default 3600
   */
  lifetimeSeconds?: number;
  /**
   * Authorize a request before issuing a token.
   * Use this to check your app session, signed cookie, or other auth state.
   */
  authorize?: (request: Request) => boolean | Promise<boolean>;
  /**
   * Allowed browser origins for CORS. If omitted, no CORS origin header is added.
   * Use exact origins such as `https://example.com`.
   */
  allowedOrigins?: string[];
  /**
   * Explicit opt-in for unauthenticated token creation. Only use for local demos.
   * @default false
   */
  allowUnauthenticated?: boolean;
}

const MIN_LIFETIME = 180;
const MAX_LIFETIME = 86400;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class PlivoJWTEndpoint {
  private readonly authId: string;
  private readonly authToken: string;
  private readonly endpointUsername: string;
  private readonly lifetimeSeconds: number;
  private readonly authorize?: (request: Request) => boolean | Promise<boolean>;
  private readonly allowedOrigins: string[];
  private readonly allowUnauthenticated: boolean;

  constructor(config: PlivoJWTEndpointConfig) {
    this.authId = config.authId;
    this.authToken = config.authToken;
    this.endpointUsername = config.endpointUsername;
    this.lifetimeSeconds = Math.min(
      MAX_LIFETIME,
      Math.max(MIN_LIFETIME, config.lifetimeSeconds ?? 3600)
    );
    this.authorize = config.authorize;
    this.allowedOrigins = config.allowedOrigins ?? [];
    this.allowUnauthenticated = config.allowUnauthenticated ?? false;
  }

  /**
   * Mint a short-lived Plivo access token for browser WebRTC login.
   *
   * Builds the JWT locally and signs it HS256 with the auth token, the same
   * structure Plivo's server SDKs use: `sub` is the endpoint username and
   * `grants.voice` enables incoming and outgoing calls.
   */
  async createToken(): Promise<string> {
    const header = { alg: "HS256", typ: "JWT", cty: "plivo;v=1" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.authId,
      sub: this.endpointUsername,
      nbf: now,
      exp: now + this.lifetimeSeconds,
      jti: `${this.endpointUsername}-${now}`,
      grants: {
        voice: { incoming_allow: true, outgoing_allow: true }
      }
    };

    const encoder = new TextEncoder();
    const signingInput = `${base64Url(
      encoder.encode(JSON.stringify(header))
    )}.${base64Url(encoder.encode(JSON.stringify(payload)))}`;

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.authToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(signingInput)
    );

    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  }

  /**
   * HTTP handler for Cloudflare Workers.
   *
   * - `POST`    → returns `{ token }` for browser WebRTC login
   * - `OPTIONS` → CORS preflight
   */
  async handleRequest(request: Request): Promise<Response> {
    const corsHeaders = this.corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    const authResponse = await this.authorizeRequest(request, corsHeaders);
    if (authResponse) return authResponse;

    if (request.method === "POST") {
      try {
        const token = await this.createToken();
        return Response.json(
          { token },
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (err) {
        return Response.json(
          { error: (err as Error).message },
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      }
    }

    return Response.json(
      { error: "Method not allowed" },
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }

  private async authorizeRequest(
    request: Request,
    headers: HeadersInit
  ): Promise<Response | null> {
    if (this.authorize) {
      const ok = await this.authorize(request);
      if (!ok) {
        return Response.json(
          { error: "Forbidden" },
          {
            status: 403,
            headers: { ...headers, "Content-Type": "application/json" }
          }
        );
      }
      return null;
    }

    if (this.allowUnauthenticated) return null;

    return Response.json(
      {
        error:
          "PlivoJWTEndpoint requires an authorize callback. Set allowUnauthenticated: true only for local demos."
      },
      {
        status: 401,
        headers: { ...headers, "Content-Type": "application/json" }
      }
    );
  }

  private corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("Origin");
    if (!origin || !this.allowedOrigins.includes(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin"
    };
  }
}
