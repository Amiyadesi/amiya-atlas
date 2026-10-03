/** PCM capture only. No browser speech service, network request or storage. */
export function encodePcmWav(samples: Float32Array): Uint8Array {
  if (samples.length < 5600 || samples.length > 16000 * 60)
    throw new Error("录音需在 0.35–60 秒之间");
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const string = (offset: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  string(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  string(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  string(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => {
    const sample = Number.isFinite(value)
      ? Math.max(-1, Math.min(1, value))
      : 0;
    view.setInt16(
      44 + i * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    );
  });
  return bytes;
}
export function wavBase64(wav: Uint8Array): string {
  let text = "";
  for (let at = 0; at < wav.length; at += 32768)
    text += String.fromCharCode(...wav.subarray(at, at + 32768));
  return btoa(text);
}

export class PcmRecorder {
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private gain?: GainNode;
  private chunks: Float32Array[] = [];
  private sampleCount = 0;
  private generation = 0;
  private flush?: () => void;
  private capped = false;
  constructor(
    private level: (value: number) => void,
    private limit: () => void,
  ) {}
  async start(): Promise<void> {
    const generation = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("录音已取消");
    }
    this.stream = stream;
    try {
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule(
        new URL("/atlas-recorder.worklet.js", window.location.href).href,
      );
      if (generation !== this.generation) throw new Error("录音已取消");
      this.worklet = new AudioWorkletNode(this.context, "atlas-pcm-recorder");
      this.worklet.port.onmessage = ({ data }) => {
        if (generation !== this.generation) return;
        if (data.type === "flushed") {
          this.flush?.();
          return;
        }
        const chunk = data.samples as Float32Array;
        const remaining = this.context!.sampleRate * 60 - this.sampleCount;
        if (chunk?.length && remaining > 0) {
          const bounded =
            chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
          this.chunks.push(bounded);
          this.sampleCount += bounded.length;
          this.level(
            Math.sqrt(
              bounded.reduce((sum, n) => sum + n * n, 0) / bounded.length,
            ),
          );
        }
        if (this.sampleCount >= this.context!.sampleRate * 60 && !this.capped) {
          this.capped = true;
          this.limit();
        }
      };
      this.source = this.context.createMediaStreamSource(stream);
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      this.source.connect(this.worklet);
      this.worklet.connect(this.gain);
      this.gain.connect(this.context.destination);
      let resumeTimeout: number | undefined;
      try {
        await Promise.race([
          this.context.resume(),
          new Promise<never>((_, reject) => {
            resumeTimeout = window.setTimeout(
              () => reject(new Error("音频未能启动，请点击语音按钮后重试")),
              2500,
            );
          }),
        ]);
      } finally {
        window.clearTimeout(resumeTimeout);
      }
      if (generation !== this.generation) throw new Error("录音已取消");
    } catch (e) {
      this.cancel();
      throw e;
    }
  }
  async stop(): Promise<Uint8Array> {
    if (!this.context || !this.worklet) throw new Error("录音尚未开始");
    const generation = this.generation;
    const rate = this.context.sampleRate;
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 300);
      this.flush = () => {
        window.clearTimeout(timer);
        resolve();
      };
      this.worklet!.port.postMessage({ type: "flush" });
    });
    if (generation !== this.generation) throw new Error("录音已取消");
    const samples = new Float32Array(this.sampleCount);
    let at = 0;
    for (const chunk of this.chunks) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    this.cancel();
    if (samples.length / rate < 0.35)
      throw new Error("录音太短，请说完一句话再停止");
    const targetCount = Math.min(
      16000 * 60,
      Math.floor((samples.length / rate) * 16000),
    );
    const offline = new OfflineAudioContext(1, targetCount, 16000);
    const buffer = offline.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    samples.fill(0);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const resampled = rendered.getChannelData(0);
    const wav = encodePcmWav(resampled);
    resampled.fill(0);
    buffer.getChannelData(0).fill(0);
    return wav;
  }
  cancel(): void {
    this.generation++;
    this.flush?.();
    this.flush = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.gain?.disconnect();
    if (this.worklet) this.worklet.port.onmessage = null;
    this.worklet = undefined;
    this.source = undefined;
    this.gain = undefined;
    void this.context?.close().catch(() => {});
    this.context = undefined;
    this.chunks.forEach((c) => c.fill(0));
    this.chunks = [];
    this.sampleCount = 0;
    this.capped = false;
    this.level(0);
  }
}
