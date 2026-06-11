export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return int16;
}

export function computeRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

export const PCM_CAPTURE_PROCESSOR_SOURCE = /* js */ `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

export const PCM_PLAYBACK_PROCESSOR_SOURCE = /* js */ `
class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._maxBufferFrames = 50;
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this._buffer = [];
        return;
      }
      this._buffer.push(e.data);
      while (this._buffer.length > this._maxBufferFrames) {
        this._buffer.shift();
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];
    let written = 0;

    while (written < channel.length && this._buffer.length > 0) {
      const frame = this._buffer[0];
      const available = frame.length;
      const needed = channel.length - written;

      if (available <= needed) {
        channel.set(frame, written);
        written += available;
        this._buffer.shift();
      } else {
        channel.set(frame.subarray(0, needed), written);
        this._buffer[0] = frame.subarray(needed);
        written += needed;
      }
    }

    for (let i = written; i < channel.length; i++) {
      channel[i] = 0;
    }

    return true;
  }
}
registerProcessor("pcm-playback-processor", PcmPlaybackProcessor);
`;
