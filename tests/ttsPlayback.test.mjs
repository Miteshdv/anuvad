import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TtsPlayback } from "../lib/ttsPlayback.ts";

const original = {
  Audio: globalThis.Audio,
  fetch: globalThis.fetch,
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};
const instances = [];
const revoked = [];
let playImpl;
let nextUrl;

class FakeAudio {
  src = "";
  onended = null;
  onerror = null;
  calls = [];
  pauses = 0;

  constructor() {
    instances.push(this);
  }

  setAttribute() {}

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }

  pause() { this.pauses++; }

  play() {
    this.calls.push(this.src);
    return playImpl(this);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function makePlayer() {
  const states = [];
  const errors = [];
  const player = new TtsPlayback({
    onSpeakingChange: (speaking) => states.push(speaking),
    onError: (error) => errors.push(error),
  });
  return { player, states, errors };
}

const request = { text: "Hello", lang: "en", gender: "default" };
const ok = () => ({ ok: true, blob: async () => new Blob(["audio"]) });
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  instances.length = 0;
  revoked.length = 0;
  nextUrl = 0;
  playImpl = () => Promise.resolve();
  globalThis.Audio = FakeAudio;
  globalThis.fetch = async () => ok();
  URL.createObjectURL = () => `blob:test-${++nextUrl}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
});

afterEach(() => {
  globalThis.Audio = original.Audio;
  globalThis.fetch = original.fetch;
  URL.createObjectURL = original.createObjectURL;
  URL.revokeObjectURL = original.revokeObjectURL;
});

test("gesture preparation and generated speech reuse the same audio element", async () => {
  const { player, states } = makePlayer();
  player.unlock();
  await player.speak(request);
  assert.equal(instances.length, 1);
  assert.match(instances[0].calls[0], /^data:audio\/wav/);
  assert.equal(instances[0].calls[1], "blob:test-1");
  assert.equal(states.at(-1), true);
  instances[0].onended();
  assert.equal(states.at(-1), false);
  assert.deepEqual(revoked, ["blob:test-1"]);
});

test("generated audio waits for an in-flight gesture preparation", async () => {
  const preparation = deferred();
  playImpl = (audio) => audio.src.startsWith("data:") ? preparation.promise : Promise.resolve();
  const { player } = makePlayer();
  player.unlock();
  const speaking = player.speak(request);
  await tick();
  assert.equal(instances[0].calls.length, 1);
  preparation.resolve();
  await speaking;
  assert.equal(instances[0].calls[1], "blob:test-1");
});

test("blocked audio is retained and replayed directly without a second TTS request", async () => {
  let calls = 0;
  let blocked = true;
  globalThis.fetch = async () => { calls += 1; return ok(); };
  playImpl = (audio) => audio.src.startsWith("blob:") && blocked
    ? Promise.reject(new DOMException("Denied", "NotAllowedError"))
    : Promise.resolve();
  const { player, states, errors } = makePlayer();
  await player.speak(request);
  assert.match(errors.at(-1), /blocked by your browser/i);
  assert.equal(states.at(-1), false);
  assert.deepEqual(revoked, []);
  blocked = false;
  assert.equal(player.replay(), true);
  assert.equal(instances[0].calls.length, 2);
  await tick();
  assert.equal(calls, 1);
  assert.equal(states.at(-1), true);
  assert.equal(errors.at(-1), null);
  instances[0].onended();
  assert.deepEqual(revoked, ["blob:test-1"]);
});

test("stop and dispose ignore late fetch, blob, and play completions", async () => {
  const fetchResult = deferred();
  globalThis.fetch = () => fetchResult.promise;
  const first = makePlayer();
  const fetchTask = first.player.speak(request);
  first.player.stop();
  fetchResult.resolve(ok());
  await fetchTask;
  assert.equal(instances.length, 0);

  const blobResult = deferred();
  globalThis.fetch = async () => ({ ok: true, blob: () => blobResult.promise });
  const second = makePlayer();
  const blobTask = second.player.speak(request);
  await tick();
  second.player.dispose();
  blobResult.resolve(new Blob(["audio"]));
  await blobTask;
  assert.equal(instances.length, 0);

  const playResult = deferred();
  globalThis.fetch = async () => ok();
  playImpl = () => playResult.promise;
  const third = makePlayer();
  const playTask = third.player.speak(request);
  await tick();
  third.player.stop();
  playResult.reject(new DOMException("Interrupted", "AbortError"));
  await playTask;
  assert.equal(third.states.at(-1), false);
  assert.equal(third.errors.at(-1), null);
  assert.deepEqual(revoked, ["blob:test-1"]);
});

test("a newer request wins over a stale response and media events", async () => {
  const firstFetch = deferred();
  globalThis.fetch = (_url, options) => JSON.parse(options.body).text === "Hello"
    ? firstFetch.promise
    : Promise.resolve(ok());
  const { player, errors } = makePlayer();
  const stale = player.speak(request);
  await player.speak({ ...request, text: "New" });
  const oldOnError = instances[0].onerror;
  firstFetch.resolve({ ok: false, json: async () => ({ error: "stale" }) });
  await stale;
  assert.equal(errors.at(-1), null);
  player.stop();
  oldOnError();
  assert.equal(errors.at(-1), null);
  assert.deepEqual(revoked, ["blob:test-1"]);
});

test("repeated browser denials can be retried and stop releases the blocked recording", async () => {
  playImpl = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
  const { player, errors } = makePlayer();
  await player.speak(request);
  assert.equal(player.replay(), true);
  await tick();
  assert.match(errors.at(-1), /blocked by your browser/i);
  assert.equal(player.replay(), true);
  await tick();
  player.stop();
  assert.equal(player.replay(), false);
  assert.deepEqual(revoked, ["blob:test-1"]);
});

test("stop cancels a replay and ignores its eventual success", async () => {
  playImpl = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
  const { player, states, errors } = makePlayer();
  await player.speak(request);
  const playing = deferred();
  playImpl = () => playing.promise;
  player.replay();
  player.stop();
  playing.resolve();
  await tick();
  assert.equal(states.at(-1), false);
  assert.equal(errors.at(-1), null);
  assert.deepEqual(revoked, ["blob:test-1"]);
});

test("a new phrase stops existing audio without allocating another element", async () => {
  const { player, states, errors } = makePlayer();
  player.unlock();
  await player.speak(request);
  const oldOnEnded = instances[0].onended;
  await player.speak({ ...request, text: "Next phrase" });
  oldOnEnded();
  assert.equal(instances.length, 1);
  assert.equal(states.at(-1), true);
  assert.equal(errors.at(-1), null);
  assert.deepEqual(revoked, ["blob:test-1"]);
  player.dispose();
  assert.deepEqual(revoked, ["blob:test-1", "blob:test-2"]);
});

test("reserved translations play in phrase order without interrupting audio", async () => {
  const { player } = makePlayer();
  const calls = [];
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body).text); return ok(); };
  const first = player.reserve(), second = player.reserve(), third = player.reserve();
  third({ ...request, text: "Third" });
  second({ ...request, text: "Second" });
  await tick();
  assert.deepEqual(calls, []);
  first({ ...request, text: "First" });
  await tick();
  const audio = instances[0], pauses = audio.pauses;
  assert.deepEqual(calls, ["First"]);
  assert.deepEqual(audio.calls, ["blob:test-1"]);
  const fourth = player.reserve(), fifth = player.reserve();
  fourth({ ...request, text: "Fourth" }); fifth({ ...request, text: "Fifth" });
  await tick();
  assert.equal(audio.pauses, pauses);
  assert.deepEqual(audio.calls, ["blob:test-1"]);
  audio.onended(); await tick();
  assert.deepEqual(calls, ["First", "Second"]);
  audio.onended(); await tick();
  assert.deepEqual(calls, ["First", "Second", "Third"]);
  audio.onended(); await tick();
  assert.deepEqual(calls, ["First", "Second", "Third", "Fourth"]);
  audio.onended(); await tick();
  assert.deepEqual(calls, ["First", "Second", "Third", "Fourth", "Fifth"]);
  audio.onended();
  assert.deepEqual(revoked, ["blob:test-1", "blob:test-2", "blob:test-3", "blob:test-4", "blob:test-5"]);
});

test("manual playback replaces current audio and invalidates unresolved reservations", async () => {
  const { player } = makePlayer();
  const calls = [];
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body).text); return ok(); };
  const first = player.reserve(), pending = player.reserve();
  first(request); await tick();
  const oldEnd = instances[0].onended;
  await player.speak({ ...request, text: "Manual" });
  pending({ ...request, text: "Stale" }); oldEnd(); await tick();
  assert.deepEqual(calls, ["Hello", "Manual"]);
  assert.deepEqual(revoked, ["blob:test-1"]);
  instances[0].onended();
  assert.deepEqual(revoked, ["blob:test-1", "blob:test-2"]);
});

for (const action of ["stop", "dispose"]) {
  test(`${action} cancels the queue and late translation results`, async () => {
    const { player } = makePlayer();
    const fetchResult = deferred();
    let calls = 0, signal;
    globalThis.fetch = (_url, options) => { calls++; signal = options.signal; return fetchResult.promise; };
    const first = player.reserve(), second = player.reserve();
    first(request);
    player[action]();
    assert.equal(signal.aborted, true);
    second({ ...request, text: "Late" });
    fetchResult.resolve(ok()); await tick();
    assert.equal(calls, 1);
    assert.equal(instances.length, 0);
  });
}

test("failed translation, TTS, and playback do not block following phrases", async () => {
  const { player, errors } = makePlayer();
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? { ok: false, status: 502, json: async () => ({ error: "No credits" }) }
    : ok();
  let plays = 0;
  playImpl = () => ++plays === 1 ? Promise.reject(new Error("Unsupported audio")) : Promise.resolve();
  const first = player.reserve(), second = player.reserve(), third = player.reserve(), fourth = player.reserve();
  fourth({ ...request, text: "Works" });
  third({ ...request, text: "Bad audio" });
  second({ ...request, text: "Bad TTS" });
  first(null);
  await tick(); await tick();
  assert.equal(calls, 3);
  assert.ok(errors.includes("No credits"));
  assert.ok(errors.includes("Unsupported audio"));
  assert.equal(instances[0].calls.length, 2);
  instances[0].onended();
  assert.deepEqual(revoked, ["blob:test-1", "blob:test-2"]);
});

test("blocked replay retries and resumes the queue after playback ends", async () => {
  const { player, errors } = makePlayer();
  let blocked = true, calls = 0;
  globalThis.fetch = async () => { calls++; return ok(); };
  playImpl = () => blocked ? Promise.reject(new DOMException("Denied", "NotAllowedError")) : Promise.resolve();
  const first = player.reserve(), second = player.reserve();
  first(request); second({ ...request, text: "Next" }); await tick();
  assert.equal(calls, 1);
  assert.equal(player.replay(request), true); await tick();
  assert.match(errors.at(-1), /blocked/i);
  assert.equal(calls, 1);
  blocked = false;
  assert.equal(player.replay(request), true); await tick();
  instances[0].onended(); await tick();
  assert.equal(calls, 2);
  instances[0].onended();
});

test("non-permission replay failures advance the queue", async () => {
  const { player, errors } = makePlayer();
  let plays = 0, calls = 0;
  globalThis.fetch = async () => { calls++; return ok(); };
  playImpl = () => ++plays === 1 ? Promise.reject(new DOMException("Denied", "NotAllowedError"))
    : plays === 2 ? Promise.reject(new Error("Replay failed")) : Promise.resolve();
  const first = player.reserve(), second = player.reserve();
  first(request); second({ ...request, text: "Next" }); await tick();
  player.replay(request); await tick(); await tick();
  assert.ok(errors.includes("Replay failed"));
  assert.equal(calls, 2);
  instances[0].onended();
});

test("API and playback failures remain visible and release resources", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({ error: "No credits" }) });
  const { player, errors } = makePlayer();
  await player.speak(request);
  assert.equal(errors.at(-1), "No credits");
  globalThis.fetch = async () => ok();
  playImpl = () => Promise.reject(new Error("Unsupported audio"));
  await player.speak(request);
  assert.equal(errors.at(-1), "Unsupported audio");
  assert.deepEqual(revoked, ["blob:test-1"]);
});
