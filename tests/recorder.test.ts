import { describe, expect, it } from "vitest";
import { encodePcmWav, wavBase64 } from "../src/features/voice/recorder";
describe("local voice audio", () => {
  it("encodes bounded 16 kHz mono PCM with clipping and no invalid samples", () => {
    const samples = new Float32Array(16000);
    samples.set([-2, -1, 0, 1, 2, NaN, Infinity]);
    const wav = encodePcmWav(samples);
    const header = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(header.getUint32(4, true)).toBe(wav.length - 8);
    expect(header.getUint32(24, true)).toBe(16000);
    expect(header.getUint16(22, true)).toBe(1);
    expect(header.getUint16(34, true)).toBe(16);
    expect(header.getUint32(40, true)).toBe(32000);
    expect(
      Array.from({ length: 7 }, (_, i) => header.getInt16(44 + i * 2, true)),
    ).toEqual([-32768, -32768, 0, 32767, 32767, 0, 0]);
    expect(Buffer.from(wavBase64(wav), "base64")).toEqual(Buffer.from(wav));
    expect(() => encodePcmWav(new Float32Array(5000))).toThrow();
    expect(() => encodePcmWav(new Float32Array(16000 * 60 + 1))).toThrow();
  });
});
