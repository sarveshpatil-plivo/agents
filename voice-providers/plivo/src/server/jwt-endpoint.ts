/**
 * Server-side JWT endpoint for Plivo WebRTC authentication.
 *
 * Wraps the Plivo JWT Token API so the browser can obtain a short-lived
 * JWT without ever seeing the auth token. Mount `handleRequest` in a
 * Cloudflare Worker route (e.g. `/api/plivo-token`).
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

export class PlivoJWTEndpoint {
  private readonly authId: string;
  private readonly authToken: string;
  private readonly authorize?: (request: Request) => boolean | Promise<boolean>;
  private readonly allowedOrigins: string[];
  private readonly allowUnauthenticated: boolean;

  constructor(config: PlivoJWTEndpointConfig) {
    this.authId = config.authId;
    this.authToken = config.authToken;
    this.authorize = config.authorize;
    this.allowedOrigins = config.allowedOrigins ?? [];
    this.allowUnauthenticated = config.allowUnauthenticated ?? false;
  }

  /**
   * Generate a short-lived JWT for Plivo WebRTC browser login.
   * One API call: POST /v1/Account/{auth_id}/JWT/Token/
   */
  async createToken(): Promise<string> {
    const auth = btoa(`${this.authId}:${this.authToken}`);
    const response = await fetch(
      `https://api.plivo.com/v1/Account/${this.authId}/JWT/Token/`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ iss: this.authId })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to create Plivo JWT: ${response.status}`);
    }

    const body = (await response.json()) as { token?: string };
    if (!body.token) {
      throw new Error("Plivo JWT response missing token field");
    }
    return body.token;
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
