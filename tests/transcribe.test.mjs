import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../app/api/transcribe/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function setup({ authorized = true, key = "test-key", status = 200, throws = false } = {}) {
  const exports = {}, calls = [];
  vm.runInNewContext(source, {
    exports, Request, Response, File, Blob, FormData, Uint8Array, AbortController, setTimeout, clearTimeout,
    process: { env: { OPENAI_API_KEY: key } },
    require: (name) => name === "next/server" ? { NextResponse: Response } : name === "@/lib/auth"
      ? { auth: async () => authorized ? { user: { id: "user" } } : null }
      : { languageByCode: (code) => ["en", "hi"].includes(code) },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (throws) throw new Error("sensitive upstream diagnostics");
      return Response.json(status === 200 ? { text: " hello " } : { error: "sensitive upstream diagnostics" }, { status });
    },
  });
  // Buffer the mock upload: Node's lazy FormData stream has a cancellation bug.
  const post = async (request) => exports.POST(new Request(request.url, {
    method: request.method, headers: request.headers, body: await request.arrayBuffer(),
  }));
  return { post, calls };
}
function upload({ mime = "audio/webm", language = "hi", bytes = [26, 69, 223, 163, 1], size } = {}) {
  const body = new FormData();
  body.append("file", new Blob([size ? new Uint8Array(size) : new Uint8Array(bytes)], { type: mime }), "untrusted-name");
  body.append("language", language);
  return new Request("https://example.com/api/transcribe", { method: "POST", body });
}
test("transcription requires auth and server configuration", async () => {
  assert.equal((await setup({ authorized: false }).post(upload())).status, 401);
  assert.equal((await setup({ key: "" }).post(upload())).status, 503);
});
test("WebM and MP4 uploads forward multipart model, language and audio with no manual content-type", async () => {
  for (const options of [{}, { mime: "audio/mp4", bytes: [0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0] }]) {
    const s = setup(), response = await s.post(upload(options));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { text: "hello" });
    const call = s.calls[0];
    assert.equal(call.url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(call.body.get("model"), "gpt-4o-mini-transcribe"); assert.equal(call.body.get("language"), "hi");
    assert.equal(call.headers.Authorization, "Bearer test-key"); assert.equal(call.headers["Content-Type"], undefined);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
test("invalid MIME, container, language, empty and oversized files never reach OpenAI", async () => {
  for (const [options, expected] of [
    [{ mime: "text/plain" }, 415], [{ bytes: [1, 2, 3] }, 400], [{ language: "hi-IN" }, 400],
    [{ bytes: [] }, 400], [{ size: 2 * 1024 * 1024 + 1 }, 413], [{ size: 2 * 1024 * 1024 + 20000 }, 413],
  ]) {
    const s = setup(); assert.equal((await s.post(upload(options))).status, expected); assert.equal(s.calls.length, 0);
  }
});
test("malformed multipart bodies and wrong request types are rejected", async () => {
  const s = setup();
  assert.equal((await s.post(new Request("https://example.com", { method: "POST", body: "bad" }))).status, 400);
  assert.equal((await s.post(new Request("https://example.com", { method: "POST", body: "bad", headers: { "content-type": "multipart/form-data; boundary=bad" } }))).status, 400);
  assert.equal(s.calls.length, 0);
});
test("provider errors are useful and sanitized", async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const response = await setup({ status }).post(upload());
    assert.ok(response.status >= 400); assert.doesNotMatch(await response.text(), /sensitive|test-key/);
  }
  const response = await setup({ throws: true }).post(upload());
  assert.equal(response.status, 502); assert.match(await response.text(), /Could not reach/);
});
