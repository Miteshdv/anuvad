import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../app/api/tts/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

test("speech synthesis forwards only supplied text and forbids appended or translated speech", async () => {
  const exports = {}, calls = [];
  vm.runInNewContext(source, {
    exports,
    process: { env: { OPENAI_API_KEY: "test-key" } },
    require: (name) => name === "next/server" ? { NextResponse: Response }
      : name === "@/lib/auth" ? { auth: async () => ({ user: { id: "user" } }) }
      : { languageByCode: (code) => ({ label: { en: "English", ko: "Korean", zh: "Chinese" }[code] }) },
    fetch: async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response("audio"); },
  });
  for (const lang of ["en", "ko", "zh"]) {
    const response = await exports.POST(new Request("https://example.com/api/tts", {
      method: "POST", body: JSON.stringify({ text: "Provided text", lang }),
    }));
    assert.equal(response.status, 200);
    const body = calls.at(-1);
    assert.equal(body.input, "Provided text");
    assert.match(body.instructions, /Read only the provided text/);
    assert.match(body.instructions, /Do not translate/);
    assert.match(body.instructions, /Stop when the provided text ends/);
  }
});
