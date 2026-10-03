import { test, expect } from "@playwright/test";
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});
test("real WebAudio worklet produces WAV and cancellation releases the microphone", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["microphone"]);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // Load the same recorder as the desktop UI; Chromium supplies a simulated microphone.
    const moduleUrl = "/src/features/voice/recorder.ts";
    const { PcmRecorder } = await import(moduleUrl);
    const tracks: MediaStreamTrack[] = [];
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await original(options);
      tracks.push(...stream.getTracks());
      return stream;
    };
    const recorder = new PcmRecorder(
      () => {},
      () => {},
    );
    await recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const wav = await recorder.stop();
    const header = new DataView(wav.buffer);
    const endedAfterStop = tracks.every((t) => t.readyState === "ended");
    const second = new PcmRecorder(
      () => {},
      () => {},
    );
    await second.start();
    second.cancel();
    const endedAfterCancel = tracks.every((t) => t.readyState === "ended");
    navigator.mediaDevices.getUserMedia = original;
    return {
      rate: header.getUint32(24, true),
      channels: header.getUint16(22, true),
      bytes: wav.length,
      endedAfterStop,
      endedAfterCancel,
    };
  });
  expect(result.rate).toBe(16000);
  expect(result.channels).toBe(1);
  expect(result.bytes).toBeGreaterThan(11244);
  expect(result.bytes).toBeLessThan(16000 * 2 * 3);
  expect(result.endedAfterStop).toBe(true);
  expect(result.endedAfterCancel).toBe(true);
});
