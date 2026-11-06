import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(
  readFileSync(new URL("../hooks/useSpeechRecognition.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function setup() {
  let now = 0;
  let nextTimer = 0;
  let recognition;
  const timers = new Map();
  const effects = [];
  const cleanups = [];
  const phrases = [];
  const states = [];
  const addTimer = (fn, delay, repeat = false) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + delay, delay, repeat });
    return id;
  };
  class Recognition {
    starts = 0;
    aborts = 0;
    failStart = false;
    start() {
      if (this.failStart) throw new Error("busy");
      this.starts++;
      this.onstart?.();
    }
    stop() { this.onend?.(); }
    abort() { this.aborts++; this.onend?.(); }
    result(text, isFinal, index = 0) {
      const results = Array.from({ length: index + 1 }, () => ({ isFinal: true, 0: { transcript: "old" } }));
      results[index] = { isFinal, 0: { transcript: text } };
      this.onresult?.({ resultIndex: index, results });
    }
  }
  const react = {
    useRef: (current) => ({ current }),
    useState: (initial) => {
      const slot = { value: initial };
      states.push(slot);
      return [initial, (value) => { slot.value = value; }];
    },
    useEffect: (fn) => effects.push(fn),
    useSyncExternalStore: () => true,
  };
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    require: () => react,
    Date: class extends Date { static now() { return now; } },
    window: {
      SpeechRecognition: function () { recognition = new Recognition(); return recognition; },
      setTimeout: (fn, delay) => addTimer(fn, delay),
      clearTimeout: (id) => timers.delete(id),
      setInterval: (fn, delay) => addTimer(fn, delay, true),
      clearInterval: (id) => timers.delete(id),
    },
  });
  const hook = exports.useSpeechRecognition({ lang: "hi-IN", onFinal: (text) => phrases.push(text) });
  for (const effect of effects) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  const advance = (ms) => {
    const end = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.repeat) timer.at += timer.delay;
      else timers.delete(id);
      timer.fn();
    }
    now = end;
  };
  return { hook, recognition, phrases, states, timers, advance, dispose: () => cleanups.forEach((fn) => fn()) };
}

test("multiple finalized phrases continue without reset, including across session endings", () => {
  const { hook, recognition, phrases, advance } = setup();
  hook.start();
  recognition.result("first", true);
  recognition.result("second", true, 1);
  recognition.onend();
  advance(250);
  recognition.result("third", true);
  assert.deepEqual(phrases, ["first", "second", "third"]);
  assert.equal(recognition.starts, 2);
  assert.equal(recognition.lang, "hi-IN");
});

test("uninterrupted interim speech is submitted and recognition resumes automatically", () => {
  const { hook, recognition, phrases, advance } = setup();
  hook.start();
  for (let i = 0; i < 8; i++) {
    recognition.result(`movie dialogue ${i}`, false);
    advance(1000);
  }
  assert.deepEqual(phrases, ["movie dialogue 7"]);
  advance(250);
  recognition.result("next scene", true);
  assert.deepEqual(phrases, ["movie dialogue 7", "next scene"]);
  assert.equal(recognition.starts, 2);
});

test("a silent stall without onend is recovered without a manual reset", () => {
  const { hook, recognition, advance } = setup();
  hook.start();
  recognition.result("first", true);
  advance(15250);
  assert.equal(recognition.aborts, 1);
  assert.equal(recognition.starts, 2);
});

test("unexpected end preserves pending speech and does not duplicate finalized text", () => {
  const { hook, recognition, phrases, advance } = setup();
  hook.start();
  recognition.result("first", true);
  recognition.result("first", true);
  recognition.result("remaining words", false, 1);
  recognition.onend();
  advance(250);
  assert.deepEqual(phrases, ["first", "remaining words"]);
});

test("stop cancels recovery and commits pending speech only once", () => {
  const { hook, recognition, phrases, advance, states } = setup();
  hook.start();
  recognition.result("last phrase", false);
  hook.stop();
  advance(30000);
  assert.deepEqual(phrases, ["last phrase"]);
  assert.equal(recognition.starts, 1);
  assert.equal(states[0].value, false);
});

test("permission denial prevents automatic restart", () => {
  const { hook, recognition, advance, states } = setup();
  hook.start();
  recognition.onerror({ error: "not-allowed" });
  recognition.onend();
  advance(30000);
  assert.equal(recognition.starts, 1);
  assert.match(states[2].value, /permission/);
});

test("failed restarts retry and cleanup cancels all timers", () => {
  const { hook, recognition, advance, dispose, timers } = setup();
  hook.start();
  recognition.failStart = true;
  recognition.onend();
  advance(750);
  recognition.failStart = false;
  advance(1000);
  assert.equal(recognition.starts, 2);
  dispose();
  assert.equal(timers.size, 0);
  assert.equal(recognition.onresult, null);
});
