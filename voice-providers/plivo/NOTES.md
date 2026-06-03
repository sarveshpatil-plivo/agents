# Notes — @cloudflare/voice-plivo

## Known limitations

- Interrupting the agent mid-speech works but can sometimes be inconsistent. When it is, there may be a delay of a second or two before the agent stops or responds.
- No retry logic if the connection to the agent drops mid-call.

## What I'd do differently for production

- Use a better speech detection method instead of a simple volume check to decide when the caller is interrupting.
- Add proper logging and metrics to track call quality (how long it takes for the agent to respond, how often interrupts happen, etc.).

## Open questions

- The adapter supports all three Plivo content types (L16 16kHz, L16 8kHz, mulaw 8kHz) but are we allowed to give the developers audio content type options to choose from depending on their use case?
