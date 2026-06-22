/**
 * @cloudflare/voice-plivo/browser
 *
 * Browser-side Plivo PSTN telephony bridge for the Cloudflare Agents SDK.
 * Depends on plivo-browser-sdk for WebRTC-based phone audio.
 */

export { PlivoCallBridge, type PlivoCallBridgeConfig } from "./call-bridge.js";
export {
  PlivoPhoneClient,
  type PlivoPhoneClientConfig,
  type PlivoPhoneClientEventMap,
  type PlivoPhoneClientEvent
} from "./phone-client.js";
