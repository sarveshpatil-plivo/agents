import { describe, expect, it } from "vitest";
import {
  computeRMS,
  float32ToInt16,
  PCM_CAPTURE_PROCESSOR_SOURCE,
  PCM_PLAYBACK_PROCESSOR_SOURCE
} from "../../src/audio/utils.js";

describe("float32ToInt16", () => {
  it("converts silence to zeros", () => {
    const result = float32ToInt16(new Float32Array([0, 0, 0]));
    expect(Array.from(result)).toEqual([0, 0, 0]);
  });

  it("converts full-scale values to int16 extremes", () => {
    const result = float32ToInt16(new Float32Array([1, -1]));
    expect(result[0]).toBe(32767);
    expect(result[1]).toBe(-32768);
  });

  it("clamps values outside [-1, 1]", () => {
    const result = float32ToInt16(new Float32Array([2.5, -3.7]));
    expect(result[0]).toBe(32767);
    expect(result[1]).toBe(-32768);
  });

  it("scales mid-range values proportionally", () => {
    const result = float32ToInt16(new Float32Array([0.5, -0.5]));
    expect(result[0]).toBe(Math.trunc(0.5 * 32767));
    expect(result[1]).toBe(-0.5 * 32768);
  });

  it("returns an empty array for empty input", () => {
    expect(float32ToInt16(new Float32Array(0))).toHaveLength(0);
  });
});

describe("computeRMS", () => {
  it("returns 0 for empty input", () => {
    expect(computeRMS(new Float32Array(0))).toBe(0);
  });

  it("returns 0 for silence", () => {
    expect(computeRMS(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it("returns the amplitude for a constant signal", () => {
    expect(computeRMS(new Float32Array([0.5, 0.5, 0.5]))).toBeCloseTo(0.5);
    expect(computeRMS(new Float32Array([-0.5, -0.5]))).toBeCloseTo(0.5);
  });

  it("computes the RMS of a mixed signal", () => {
    // RMS of [1, -1, 1, -1] is 1.
    expect(computeRMS(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1);
    // RMS of [0.6, 0.8] is sqrt((0.36 + 0.64) / 2) = sqrt(0.5).
    expect(computeRMS(new Float32Array([0.6, 0.8]))).toBeCloseTo(
      Math.sqrt(0.5)
    );
  });
});

describe("AudioWorklet processor sources", () => {
  it("registers the capture processor under its expected name", () => {
    expect(PCM_CAPTURE_PROCESSOR_SOURCE).toContain(
      'registerProcessor("pcm-capture-processor"'
    );
  });

  it("registers the playback processor under its expected name", () => {
    expect(PCM_PLAYBACK_PROCESSOR_SOURCE).toContain(
      'registerProcessor("pcm-playback-processor"'
    );
  });
});
