import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { type AiStore, type AiTask, AiUnavailable, createGemini } from "../_shared/gemini.ts";

type Reply = { status: number; body?: unknown } | Error;

function fakeFetch(replies: Record<string, Reply[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const model = url.match(/models\/([^:]+):/)?.[1] ?? "";
    const r = replies[model]?.shift();
    if (!r) return Promise.reject(new Error(`no reply for ${model}`));
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), { status: r.status }));
  };
  return { fn: fn as typeof fetch, calls };
}

function store(models: string[], opts: { failLog?: boolean } = {}) {
  const log: [string, AiTask, boolean][] = [];
  const s: AiStore = {
    getModels: () => Promise.resolve(models),
    logUsage: (m, t, is429) => {
      log.push([m, t, is429]);
      return opts.failLog ? Promise.reject(new Error("db down")) : Promise.resolve();
    },
  };
  return { s, log };
}

const ok = (text: string) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text }] } }] } });

Deno.test("generate falls back on 429 then succeeds", async () => {
  const f = fakeFetch({ m1: [{ status: 429 }], m2: [ok("hi")] });
  const { s, log } = store(["m1", "m2"]);
  const r = await createGemini({ apiKey: "k", store: s, fetch: f.fn }).generate("draft", "p");
  assertEquals(r, { text: "hi", model: "m2" });
  assertEquals(log, [["m1", "draft", true], ["m2", "draft", false]]);
});

Deno.test("generate falls back on 404 and 503", async () => {
  const f = fakeFetch({ m1: [{ status: 404 }], m2: [{ status: 503 }], m3: [ok("x")] });
  const r = await createGemini({ apiKey: "k", store: store(["m1", "m2", "m3"]).s, fetch: f.fn }).generate("verify", "p");
  assertEquals(r.model, "m3");
});

Deno.test("generate falls back on network error", async () => {
  const f = fakeFetch({ m1: [new Error("reset")], m2: [ok("x")] });
  const r = await createGemini({ apiKey: "k", store: store(["m1", "m2"]).s, fetch: f.fn }).generate("draft", "p");
  assertEquals(r.model, "m2");
});

Deno.test("generate throws immediately on 400", async () => {
  const f = fakeFetch({ m1: [{ status: 400, body: { error: { message: "bad" } } }], m2: [ok("x")] });
  const err = await assertRejects(() => createGemini({ apiKey: "k", store: store(["m1", "m2"]).s, fetch: f.fn }).generate("draft", "p"));
  assertEquals(err instanceof AiUnavailable, false);
  assertEquals(f.calls.length, 1);
});

Deno.test("generate throws AiUnavailable when all models fail", async () => {
  const f = fakeFetch({ m1: [{ status: 429 }], m2: [{ status: 500 }] });
  const err = await assertRejects(() => createGemini({ apiKey: "k", store: store(["m1", "m2"]).s, fetch: f.fn }).generate("draft", "p"));
  assertEquals((err as AiUnavailable).code, "AI_UNAVAILABLE");
});

Deno.test("generate drops thought parts", async () => {
  const f = fakeFetch({ m1: [{ status: 200, body: { candidates: [{ content: { parts: [{ text: "x", thought: true }, { text: "answer" }] } }] } }] });
  const r = await createGemini({ apiKey: "k", store: store(["m1"]).s, fetch: f.fn }).generate("draft", "p");
  assertEquals(r.text, "answer");
});

Deno.test("generate sends responseSchema when schema given", async () => {
  const f = fakeFetch({ m1: [ok("{}")] });
  const schema = { type: "OBJECT", properties: { a: { type: "STRING" } } };
  await createGemini({ apiKey: "k", store: store(["m1"]).s, fetch: f.fn }).generate("handoff", "p", { schema });
  const body = JSON.parse(String(f.calls[0].init.body));
  assertEquals(body.generationConfig, { responseMimeType: "application/json", responseSchema: schema });
  assertEquals(body.contents[0].parts[0].text, "p");
});

Deno.test("generate sends api key in x-goog-api-key header, not in URL", async () => {
  const f = fakeFetch({ m1: [ok("x")] });
  await createGemini({ apiKey: "secret-key", store: store(["m1"]).s, fetch: f.fn }).generate("draft", "p");
  assertEquals((f.calls[0].init.headers as Record<string, string>)["x-goog-api-key"], "secret-key");
  assertEquals(f.calls[0].url.includes("secret-key"), false);
  assertEquals(f.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent");
});

Deno.test("embed batches 150 texts into 2 requests and keeps order", async () => {
  const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
  const reply = (from: number, n: number) => ({
    status: 200,
    body: { embeddings: Array.from({ length: n }, (_, i) => ({ values: [from + i] })) },
  });
  const f = fakeFetch({ e1: [reply(0, 100), reply(100, 50)] });
  const out = await createGemini({ apiKey: "k", store: store(["e1"]).s, fetch: f.fn }).embed(texts, "query");
  assertEquals(f.calls.length, 2);
  assertEquals(out.length, 150);
  assertEquals(out[149], [149]);
  const body = JSON.parse(String(f.calls[0].init.body));
  assertEquals(body.requests[0], { model: "models/e1", content: { parts: [{ text: "t0" }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: 768 });
  assertEquals(f.calls[0].url.endsWith("models/e1:batchEmbedContents"), true);
});

Deno.test("logUsage failure does not break generate", async () => {
  const f = fakeFetch({ m1: [ok("fine")] });
  const r = await createGemini({ apiKey: "k", store: store(["m1"], { failLog: true }).s, fetch: f.fn }).generate("draft", "p");
  assertEquals(r.text, "fine");
});
