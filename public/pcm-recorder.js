class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(Math.round(sampleRate * 1.2));
    this.offset = 0;
    this.stopped = false;
    this.speechAtBoundary = false;
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
    this.offset = 0;
    const windowSize = Math.round(sampleRate * 0.02);
    let activeSamples = 0;
    let lastWindowActive = false;
    for (let offset = 0; offset < samples.length; offset += windowSize) {
      const end = Math.min(offset + windowSize, samples.length);
      let energy = 0;
      for (let i = offset; i < end; i++) energy += samples[i] * samples[i];
      lastWindowActive = Math.sqrt(energy / (end - offset)) >= 0.008;
      if (lastWindowActive) activeSamples += end - offset;
    }
    // Keep short voiced tails when they continue speech across a boundary.
    const hasSpeech = activeSamples >= sampleRate * 0.08 || (this.speechAtBoundary && activeSamples > 0);
    this.speechAtBoundary = lastWindowActive;
    if (!hasSpeech) return;
    this.port.postMessage({ type: "segment", samples }, [samples.buffer]);
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
