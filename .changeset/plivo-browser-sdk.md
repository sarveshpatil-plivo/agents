---
"@cloudflare/voice-plivo": minor
---

Add a browser SDK for Plivo WebRTC voice, exported from the `/browser` subpath.

`PlivoCallBridge` captures and plays WebRTC call audio via AudioWorklets, `PlivoPhoneClient` speaks the voice protocol with silence and interrupt detection, `PlivoPhoneTransport` routes server audio to the bridge, and `createPlivoVoiceConfig` wires it all up from a single JWT endpoint call. Server-side, `PlivoJWTEndpoint` issues short-lived Plivo JWTs so the auth token never reaches the browser.
