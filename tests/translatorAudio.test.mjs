import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { TtsPlayback } from "../lib/ttsPlayback.ts";

const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const workspaceSource = compile("../components/TranslatorWorkspace.tsx");
const hookSource = compile("../hooks/useTtsPlayback.ts");
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function setup() {
  let cursor = 0, effects = [], onFinal, getAudioEpoch, speechListening = false;
  const slots = [], cleanups = [], translations = [], ttsRequests = [], audios = [], urls = [];
  const react = {
    useRef: (initial) => { const i = cursor++; return slots[i] ??= { current: initial }; },
    useState: (initial) => {
      const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useEffect: (effect, deps) => {
      const i = cursor++, previous = slots[i];
      if (!previous || deps.some((value, n) => value !== previous[n])) {
        slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = effect(); });
      }
    },
  };
  class AudioMock {
    src = ""; onended = null; onerror = null; plays = [];
    constructor() { audios.push(this); }
    setAttribute() {}
    removeAttribute() { this.src = ""; }
    pause() {}
    play() { this.plays.push(this.src); return Promise.resolve(); }
  }
  const original = { Audio: globalThis.Audio, fetch: globalThis.fetch, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.Audio = AudioMock;
  URL.createObjectURL = () => { const url = `blob:${urls.length + 1}`; urls.push(url); return url; };
  URL.revokeObjectURL = () => {};
  globalThis.fetch = (path, options) => {
    if (path === "/api/usage") return Promise.resolve({ ok: true, json: async () => ({}) });
    if (path === "/api/translate") { const result = deferred(); translations.push({ ...result, body: JSON.parse(options.body), signal: options.signal }); return result.promise; }
    if (path === "/api/tts") { ttsRequests.push(JSON.parse(options.body)); return Promise.resolve({ ok: true, blob: async () => new Blob(["audio"]) }); }
    throw new Error(`Unexpected request ${path}`);
  };
  const hookExports = {};
  vm.runInNewContext(hookSource, { exports: hookExports, require: (id) => id === "react" ? react : { TtsPlayback } });
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const langs = { LANGUAGES: [], DEFAULT_SOURCE: "en", DEFAULT_TARGET: "hi", languageByCode: (code) => ({ label: code, bcp47: code }) };
  const exports = {};
  vm.runInNewContext(workspaceSource, { exports, Date, AbortController, window: { setTimeout: () => 1, clearTimeout: () => {} }, fetch: globalThis.fetch,
    require: (id) => {
      if (id === "react") return react;
      if (id === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (id === "@/lib/languages") return langs;
      if (id === "@/hooks/useTtsPlayback") return hookExports;
      if (id === "@/hooks/useSpeechRecognition") return { useSpeechRecognition: (options) => {
        onFinal = options.onFinal; getAudioEpoch = options.getAudioEpoch;
        return { listening: speechListening, supported: true, interim: "", start: () => { speechListening = true; }, stop: () => { speechListening = false; }, reset: () => {} };
      } };
      if (id.endsWith(".css")) return { default: {} };
      throw new Error(id);
    },
  });
  let tree;
  const render = () => { cursor = 0; effects = []; tree = exports.default(); effects.forEach((effect) => effect()); return tree; };
  const find = (predicate, node = tree) => {
    if (Array.isArray(node)) return node.flatMap((child) => child == null ? [] : find(predicate, child));
    if (!node || typeof node !== "object") return [];
    const children = node.props?.children;
    return [...(predicate(node) ? [node] : []), ...(children == null ? [] : find(predicate, children))];
  };
  const button = (label) => find((node) => node.type === "button" && (node.props.title === label || node.props.children === label || (Array.isArray(node.props.children) && node.props.children.includes(label))))[0];
  const respond = async (index, text, ok = true) => { translations[index].resolve({ ok, status: ok ? 200 : 500, json: async () => ok ? { translated: text } : { error: text } }); await flush(); };
  const dispose = () => { cleanups.forEach((fn) => fn?.()); globalThis.Audio = original.Audio; globalThis.fetch = original.fetch; URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke; };
  render();
  return { render, find, button, epoch: () => getAudioEpoch(), final: (text, epoch = getAudioEpoch()) => onFinal(text, epoch), respond, translations, ttsRequests, audios, dispose };
}

test("workspace preserves phrase order across delayed translation responses", async () => {
  const s = setup();
  try {
    s.final("first"); s.final("second"); s.final("third"); s.render();
    await s.respond(2, "tercero"); await s.respond(1, "segundo");
    assert.equal(s.ttsRequests.length, 0);
    await s.respond(0, "primero");
    assert.deepEqual(s.ttsRequests.map((r) => r.text), ["primero"]);
    s.audios[0].onended(); await flush();
    s.audios[0].onended(); await flush();
    assert.deepEqual(s.ttsRequests.map((r) => r.text), ["primero", "segundo", "tercero"]);
  } finally { s.dispose(); }
});

test("workspace manual playback replaces queue and disable prevents stale results after re-enable", async () => {
  const s = setup();
  try {
    s.final("one"); s.final("two"); s.render();
    await s.respond(0, "uno"); s.render();
    s.button("Play translation").props.onClick(); await flush();
    assert.deepEqual(s.ttsRequests.map((r) => r.text), ["uno", "uno"]);
    await s.respond(1, "dos"); await flush();
    assert.deepEqual(s.ttsRequests.map((r) => r.text), ["uno", "uno"]);
    s.final("three"); s.render();
    const toggle = s.find((node) => node.type === "input" && node.props.type === "checkbox")[0];
    const oldEpoch = s.epoch();
    toggle.props.onChange({ target: { checked: false } }); s.render();
    toggle.props.onChange({ target: { checked: true } }); s.render();
    await s.respond(2, "tres"); await flush();
    s.final("old segment", oldEpoch); s.render();
    await s.respond(3, "viejo");
    s.final("segment recorded while disabled", null); s.render();
    await s.respond(4, "desactivado");
    assert.deepEqual(s.ttsRequests.map((r) => r.text), ["uno", "uno"]);
  } finally { s.dispose(); }
});

test("workspace stop and reset invalidate pending translated audio", async () => {
  const s = setup();
  try {
    s.button("Start listening").props.onClick(); s.render();
    const epoch = s.epoch();
    s.final("one"); s.render();
    s.button("Stop listening").props.onClick(); s.render();
    await s.respond(0, "uno");
    s.final("final recorded segment", epoch); s.render();
    await s.respond(1, "final");
    assert.equal(s.ttsRequests.length, 0);
    s.final("another phrase"); s.render();
    s.button("Reset chat").props.onClick(); s.render();
    assert.equal(s.translations[2].signal.aborted, true);
    await s.respond(2, "stale");
    assert.equal(s.ttsRequests.length, 0);
  } finally { s.dispose(); }
});
