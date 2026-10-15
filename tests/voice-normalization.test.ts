import { describe, expect, it } from "vitest";
import { encodePcmWav, normalizePcm } from "../src/features/voice/recorder";

describe("microphone normalization", () => {
  it("makes quiet speech usable without clipping", () => {
    const quiet = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 10) * 0.004 + 0.002);
    normalizePcm(quiet);
    const rms = Math.sqrt(quiet.reduce((sum, value) => sum + value * value, 0) / quiet.length);
    expect(rms).toBeGreaterThan(0.06);
    expect(Math.max(...quiet)).toBeLessThanOrEqual(0.95);
    expect(encodePcmWav(quiet)).toHaveLength(32044);
  });
  it("rejects silence and removes DC instead of amplifying it", () => {
    expect(() => normalizePcm(new Float32Array(16000).fill(0.002))).toThrow("麦克风没有收到声音");
  });
});
