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
  const frames = 48000 * 30 + 71;
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
