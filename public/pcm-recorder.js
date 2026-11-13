class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(Math.round(sampleRate * 1.2));
    this.offset = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type !== "stop" || this.stopped) return;
      this.stopped = true;
      this.flush();
      this.port.postMessage({ type: "stopped" });
    };
  }

  flush() {
    if (!this.offset) return;
    const samples = this.samples.slice(0, this.offset);
    this.port.postMessage({ type: "segment", samples }, [samples.buffer]);
    this.offset = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame++) {
      let sample = 0;
      for (const channel of channels) sample += channel[frame];
      this.samples[this.offset++] = sample / channels.length;
      if (this.offset === this.samples.length) this.flush();
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorder);
