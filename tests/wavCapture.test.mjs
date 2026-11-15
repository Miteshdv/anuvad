import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/wav.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, Blob });

test("PCM encoder clamps samples and writes accurate WAV sizes and rate", async () => {
  const view = new DataView(await exports.encodeWav(new Float32Array([-2, -1, 0, 1, 2]), 44100).arrayBuffer());
  assert.equal(view.getUint32(4, true), 46);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint32(40, true), 10);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, 0, 32767, 32767]);
});

test("continuous worklet keeps every frame across long speech and flushes its final partial segment once", () => {
  let Processor;
  const messages = [];
  vm.runInNewContext(readFileSync(new URL("../public/pcm-recorder.js", import.meta.url), "utf8"), {
    sampleRate: 48000,
    AudioWorkletProcessor: class { port = { postMessage: (data) => messages.push(data) }; },
    registerProcessor: (_name, processor) => { Processor = processor; },
  });
  const processor = new Processor();
  const frames = 48000 * 30 + 12000;
  for (let offset = 0; offset < frames; offset += 128) {
    const input = Float32Array.from({ length: Math.min(128, frames - offset) }, (_, i) => ((offset + i) % 100) / 100);
    assert.equal(processor.process([[input, input]]), true);
  }
  processor.port.onmessage({ data: { type: "stop" } });
  processor.port.onmessage({ data: { type: "stop" } });
  const segments = messages.filter((message) => message.type === "segment");
  assert.equal(segments.length, 26);
  assert.equal(segments.reduce((sum, { samples }) => sum + samples.length, 0), frames);
  let offset = 0;
  for (const { samples } of segments) {
    for (const sample of samples) assert.equal(sample, Math.fround((offset++ % 100) / 100));
  }
  assert.equal(messages.filter((message) => message.type === "stopped").length, 1);
  assert.equal(processor.process([]), false);
});

test("silence, low background noise, and tiny stop tails are not submitted", () => {
  let Processor;
  const messages = [];
  vm.runInNewContext(readFileSync(new URL("../public/pcm-recorder.js", import.meta.url), "utf8"), {
    sampleRate: 48000,
    AudioWorkletProcessor: class { port = { postMessage: (data) => messages.push(data) }; },
    registerProcessor: (_name, processor) => { Processor = processor; },
  });
  for (const samples of [new Float32Array(57600), new Float32Array(57600).fill(0.002), new Float32Array(100).fill(0.1)]) {
    const processor = new Processor();
    processor.process([[samples]]);
    processor.port.onmessage({ data: { type: "stop" } });
  }
  assert.equal(messages.filter((m) => m.type === "segment").length, 0);
  assert.equal(messages.filter((m) => m.type === "stopped").length, 3);
});

test("short speech survives surrounding silence and voiced continuation tails are retained", () => {
  let Processor;
  const messages = [];
  vm.runInNewContext(readFileSync(new URL("../public/pcm-recorder.js", import.meta.url), "utf8"), {
    sampleRate: 48000,
    AudioWorkletProcessor: class { port = { postMessage: (data) => messages.push(data) }; },
    registerProcessor: (_name, processor) => { Processor = processor; },
  });
  const voiced = (length) => Float32Array.from({ length }, (_, i) => 0.02 * Math.sin(2 * Math.PI * 200 * i / 48000));
  const short = new Float32Array(57600);
  short.set(voiced(9600), 4800);
  new Processor().process([[short]]);
  assert.equal(messages.filter((m) => m.type === "segment").length, 1);
  messages.length = 0;
  const processor = new Processor();
  processor.process([[voiced(59520)]]);
  processor.port.onmessage({ data: { type: "stop" } });
  assert.equal(messages.filter((m) => m.type === "segment").reduce((sum, m) => sum + m.samples.length, 0), 59520);
});
