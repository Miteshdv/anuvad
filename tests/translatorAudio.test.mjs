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
  return { render, find, button, final: (text) => onFinal(text), respond, translations, ttsRequests, audios, dispose };
}

test("speech and typing never translate or play automatically", async () => {
  const s = setup();
  try {
    s.final("hello."); s.final("world"); s.render();
    const source = () => s.find((n) => n.props["aria-label"] === "Source text")[0];
    assert.equal(source().props.value, "hello. world");
    assert.equal(s.translations.length, 0);
    source().props.onChange({ target: { value: "typed text" } }); s.render();
    assert.equal(s.translations.length, 0);
    s.button("Translate").props.onClick(); s.render();
    assert.equal(s.translations.length, 1);
    assert.equal(s.translations[0].body.text, "typed text");
    await s.respond(0, "translation"); s.render();
    assert.equal(s.ttsRequests.length, 0);
    assert.equal(s.find((n) => n.props["aria-label"] === "Translated text")[0].props.value, "translation");
    s.button("\u25b6 Replay latest").props.onClick(); await flush();
    assert.deepEqual(s.ttsRequests.map((r) => r.text), ["translation"]);
  } finally { s.dispose(); }
});

test("editing, clearing, and language changes invalidate pending translation", async () => {
  for (const action of ["edit", "clear", "language"]) {
    const s = setup();
    try {
      s.final("first"); s.render();
      s.button("Translate").props.onClick(); s.render();
      if (action === "edit") s.final("second");
      if (action === "clear") s.button("Clear all").props.onClick();
      if (action === "language") s.find((n) => n.type === "select")[1].props.onChange({ target: { value: "es" } });
      s.render();
      assert.equal(s.translations[0].signal.aborted, true);
      await s.respond(0, "stale"); s.render();
      assert.equal(s.find((n) => n.props["aria-label"] === "Translated text")[0].props.value, "");
      assert.equal(s.ttsRequests.length, 0);
    } finally { s.dispose(); }
  }
});
