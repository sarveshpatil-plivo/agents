import {
  PlivoCallBridge,
  type PlivoCallBridgeConfig
} from "../providers/call-bridge.js";

export interface PlivoVoiceConfigOptions {
  /** URL of the PlivoJWTEndpoint handler (e.g. `/api/plivo-token`). */
  jwtEndpoint: string;
  /** Automatically answer inbound calls. @default false */
  autoAnswer?: boolean;
  /** Enable Plivo SDK debug logging. @default false */
  debug?: boolean;
}

export interface PlivoVoiceSetup {
  /** The PlivoCallBridge — use for playAudio(), call(), hangup(), etc. */
  bridge: PlivoCallBridge;
  /** Pass to VoiceClientOptions.audioInput. Same as `bridge`. */
  audioInput: PlivoCallBridge;
  /** Stop the bridge and disconnect from Plivo. */
  cleanup: () => void;
}

/**
 * Fetch a JWT from the server, create a PlivoCallBridge, and return
 * everything needed to configure a VoiceClient for browser voice calls.
 */
export async function createPlivoVoiceConfig(
  options: PlivoVoiceConfigOptions
): Promise<PlivoVoiceSetup> {
  const response = await fetch(options.jwtEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Plivo JWT: ${response.status}`);
  }

  const body = (await response.json()) as { token?: string };
  if (!body.token) {
    throw new Error("Plivo JWT response missing token");
  }

  const bridgeConfig: PlivoCallBridgeConfig = {
    loginToken: body.token,
    autoAnswer: options.autoAnswer,
    debug: options.debug
  };

  const bridge = new PlivoCallBridge(bridgeConfig);

  return {
    bridge,
    audioInput: bridge,
    cleanup: () => bridge.stop()
  };
}
