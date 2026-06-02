---
"@cloudflare/voice-plivo": minor
---

Add Plivo audio streaming adapter for the Cloudflare Agents voice pipeline.

`PlivoAdapter` bridges Plivo's bidirectional audio streaming WebSocket protocol to `VoiceAgent`, structured as a sibling to the Twilio provider. Uses L16 16kHz PCM natively — no mulaw decoding or resampling required. Includes interrupt handling via `clearAudio`.
