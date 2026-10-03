class AtlasPcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.length = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "flush") {
        this.send();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }
  send() {
    if (!this.length) return;
    const samples = this.buffer.slice(0, this.length);
    this.port.postMessage({ type: "samples", samples }, [samples.buffer]);
    this.buffer.fill(0);
    this.length = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      this.buffer[this.length++] = value / channels.length;
      if (this.length === this.buffer.length) this.send();
    }
    return true;
  }
}
registerProcessor("atlas-pcm-recorder", AtlasPcmRecorder);
