import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../hooks/useSpeechRecognition.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const wavExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/wav.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: wavExports, Blob });
function setup({ permission, available = true, getAudioEpoch, moduleLoad } = {}) {
  let now = 0, nextId = 0;
  const timers = new Map(), effects = [], cleanups = [], states = [], phrases = [], recorders = [], requests = [];
  const listeners = new Map();
  const track = { readyState: "live", stops: 0, stop() { this.stops++; this.readyState = "ended"; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let context;
  class Context {
    sampleRate = 48000;
    destination = {};
    closed = false;
    audioWorklet = { addModule: async (url) => { assert.equal(url, "/pcm-recorder.js"); await moduleLoad?.promise; } };
    constructor() { context = { isClosed: () => this.closed }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  class Processor {
    constructor() {
      recorders.push(this);
      this.captureTimer = null;
      this.port = { postMessage: () => {
        if (this.hang) return;
        this.emit();
        this.port.onmessage?.({ data: { type: "stopped" } });
      } };
      this.emit = () => this.port.onmessage?.({ data: { type: "segment", samples: new Float32Array(57600) } });
    }
    connect() {
      const tick = () => { if (context.isClosed() || track.readyState === "ended") return; this.emit(); schedule(); };
      const schedule = () => { const id = ++nextId; this.captureTimer = id; timers.set(id, { fn: tick, at: now + 1200 }); };
      schedule();
    }
    disconnect() { timers.delete(this.captureTimer); }
  }
  const react = {
    useRef: (current) => ({ current }),
    useState: (initial) => { const slot = { value: initial }; states.push(slot); return [initial, (value) => { slot.value = value; }]; },
    useEffect: (fn) => effects.push(fn),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const exports = {};
  vm.runInNewContext(source, {
    exports, require: (name) => name === "react" ? react : wavExports, Blob, FormData, AbortController, Error, AudioContext: available ? Context : undefined, AudioWorkletNode: available ? Processor : undefined,
    navigator: { mediaDevices: { getUserMedia: () => permission?.promise ?? Promise.resolve(stream) } },
    document: { visibilityState: "visible", addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: (key) => listeners.delete(key) },
    window: {
      addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: (key) => listeners.delete(key),
      setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; },
      clearTimeout: (id) => timers.delete(id),
    },
    fetch: (_url, options) => { const result = deferred(); requests.push({ ...result, ...options }); options.signal.addEventListener("abort", () => result.reject(new Error("aborted"))); return result.promise; },
  });
  const hook = exports.useSpeechRecognition({ lang: "hi-IN", getAudioEpoch, onFinal: (text, audioEpoch) => phrases.push(getAudioEpoch ? { text, audioEpoch } : text) });
  effects.forEach((effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  const advance = async (ms) => {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end;
  };
  const respond = async (index, text, status = 200) => { requests[index].resolve({ ok: status === 200, json: async () => status === 200 ? { text } : { error: text } }); await flush(); };
  return { hook, states, phrases, recorders, requests, track, stream, timers, listeners, advance, respond, dispose: () => cleanups.forEach((fn) => fn()) };
}

test("successive WAV segments have independent headers and reuse one continuous capture", async () => {
  const s = setup(); s.hook.start(); await flush(); await s.advance(2400);
  assert.equal(s.recorders.length, 1); assert.equal(s.requests.length, 2);
  for (const request of s.requests) {
    const file = request.body.get("file"), view = new DataView(await file.arrayBuffer());
    assert.equal(file.type, "audio/wav"); assert.equal(file.name, "segment.wav");
    assert.equal(view.getUint32(0), 0x52494646); assert.equal(view.getUint32(8), 0x57415645);
    assert.equal(view.getUint32(40, true), 57600 * 2);
    assert.equal(request.body.get("language"), "hi");
  }
  await s.respond(0, " first  phrase "); await s.respond(1, "second phrase");
  assert.deepEqual(s.phrases, ["first phrase", "second phrase"]); assert.equal(s.track.stops, 0); s.dispose();
});
test("out-of-order responses are emitted in capture order, including empty results", async () => {
  const s = setup(); s.hook.start(); await flush(); await s.advance(2400);
  await s.respond(1, "second"); assert.deepEqual(s.phrases, []);
  await s.respond(0, ""); assert.deepEqual(s.phrases, ["second"]); s.dispose();
});
test("segments retain their audio epoch even when transcription completes after a toggle", async () => {
  let epoch = 1;
  const s = setup({ getAudioEpoch: () => epoch }); s.hook.start(); await flush();
  await s.advance(1200); epoch = null; await s.advance(1200); epoch = 2;
  await s.respond(1, "disabled phrase"); await s.respond(0, "earlier phrase");
  assert.deepEqual(s.phrases, [{ text: "earlier phrase", audioEpoch: 1 }, { text: "disabled phrase", audioEpoch: 1 }]);
  await s.advance(1200); await s.respond(2, "new phrase");
  assert.deepEqual(s.phrases.at(-1), { text: "new phrase", audioEpoch: null });
  await s.advance(1200); await s.respond(3, "after toggle");
  assert.deepEqual(s.phrases.at(-1), { text: "after toggle", audioEpoch: 2 });
  s.dispose();
});

test("normal stop releases mic promptly and submits final segment exactly once", async () => {
  const s = setup(); s.hook.start(); await flush(); s.hook.stop();
  assert.equal(s.track.stops, 1); assert.equal(s.states[0].value, false); assert.equal(s.requests.length, 1);
  s.hook.stop(); await s.respond(0, "final"); await s.advance(2400);
  assert.deepEqual(s.phrases, ["final"]); assert.equal(s.recorders.length, 1); s.dispose();
});
for (const action of ["discard", "reset", "dispose"]) {
  test(`${action} discards recordings, aborts requests, and ignores stale responses`, async () => {
    const s = setup(); s.hook.start(); await flush(); await s.advance(1200);
    if (action === "discard") s.hook.stop(false); else if (action === "reset") s.hook.reset(); else s.dispose();
    assert.equal(s.track.stops, 1); assert.equal(s.requests[0].signal.aborted, true);
    await s.respond(0, "stale"); await s.advance(20000);
    assert.deepEqual(s.phrases, []); assert.equal(s.timers.size, 0);
  });
}
for (const action of ["stop", "dispose", "reset"]) {
  test(`${action} during pending mic permission releases late-acquired stream`, async () => {
    const permission = deferred(), s = setup({ permission }); s.hook.start();
    if (action === "dispose") s.dispose(); else s.hook[action]();
    permission.resolve(s.stream); await flush(); assert.equal(s.track.stops, 1); assert.equal(s.recorders.length, 0);
  });
}
test("denied mic permission and unavailable APIs report clear errors", async () => {
  const permission = deferred(), s = setup({ permission }); s.hook.start();
  permission.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })); await flush();
  assert.equal(s.states[0].value, false); assert.match(s.states[2].value, /permission/);
  const unsupported = setup({ available: false }); unsupported.hook.start(); assert.equal(unsupported.hook.supported, false); assert.match(unsupported.states[2].value, /unavailable/);
});
for (const event of ["onended", "onmute"]) {
  test(`track ${event} clears listening and discards pending audio`, async () => {
    const s = setup(); s.hook.start(); await flush(); s.track[event]();
    assert.equal(s.states[0].value, false); assert.equal(s.track.stops, 1); assert.match(s.states[2].value, /ended|interrupted/); assert.equal(s.requests.length, 0);
  });
}
test("slow service bounds concurrency and backlog then stops with a useful error", async () => {
  const s = setup(); s.hook.start(); await flush(); await s.advance(8400);
  assert.equal(s.requests.length, 2); assert.equal(s.recorders.length, 1); assert.equal(s.states[0].value, false);
  assert.match(s.states[2].value, /cannot keep up/); assert.equal(s.track.stops, 1); assert.ok(s.requests.every((r) => r.signal.aborted));
});
test("transcription errors stop recording and are exposed", async () => {
  const s = setup(); s.hook.start(); await flush(); await s.advance(1200); await s.respond(0, "Transcription billing quota exceeded", 429);
  assert.equal(s.states[0].value, false); assert.match(s.states[2].value, /billing quota/); assert.equal(s.track.stops, 1);
});
test("timed-out final transcription does not stay pending", async () => {
  const s = setup(); s.hook.start(); await flush(); s.hook.stop(); await s.advance(30000);
  assert.match(s.states[2].value, /timed out/); assert.equal(s.timers.size, 0);
});
test("processor errors and a missing final flush cannot leave listening stuck", async () => {
  for (const event of ["onprocessorerror", "hang"]) {
    const s = setup(); s.hook.start(); await flush();
    if (event === "hang") { s.recorders[0].hang = true; s.hook.stop(); await s.advance(2000); } else s.recorders[0][event]();
    assert.equal(s.states[0].value, false); assert.ok(s.states[2].value); assert.equal(s.track.stops, 1);
  }
});
test("page backgrounding stops mic and submits final audio", async () => {
  const s = setup(); s.hook.start(); await flush(); s.listeners.get("pagehide")();
  assert.equal(s.track.stops, 1); await s.respond(0, "last"); assert.deepEqual(s.phrases, ["last"]); s.dispose();
});

test("stopping during worklet loading closes audio and ignores late setup", async () => {
  const moduleLoad = deferred(), s = setup({ moduleLoad });
  s.hook.start(); await flush(); s.hook.stop(); moduleLoad.resolve(); await flush();
  assert.equal(s.recorders.length, 0); assert.equal(s.track.stops, 1); assert.equal(s.states[0].value, false);
  s.dispose();
});

test("extended fast speech uploads independent WAV files without restarting capture", async () => {
  const s = setup(); s.hook.start(); await flush();
  for (let i = 0; i < 60; i++) {
    await s.advance(1200);
    const view = new DataView(await s.requests[i].body.get("file").arrayBuffer());
    assert.equal(view.getUint32(0), 0x52494646);
    assert.equal(view.getUint32(4, true), view.byteLength - 8);
    await s.respond(i, `phrase ${i}`);
  }
  assert.equal(s.phrases.length, 60); assert.equal(s.recorders.length, 1);
  assert.equal(s.track.stops, 0); assert.equal(s.states[2].value, null);
  s.dispose(); assert.equal(s.track.stops, 1);
});
test("worklet loading failure releases the microphone and reports an error", async () => {
  const moduleLoad = deferred(), s = setup({ moduleLoad });
  s.hook.start(); await flush(); moduleLoad.reject(new Error("load failed")); await flush();
  assert.equal(s.track.stops, 1); assert.equal(s.states[0].value, false);
  assert.match(s.states[2].value, /Could not start/); s.dispose();
});
