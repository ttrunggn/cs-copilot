import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { type AiStore, type AiTask, AiUnavailable } from "../_shared/gemini.ts";
import { type AiTraceEvent, createOpenAi, toOpenAiJsonSchema } from "../_shared/openai.ts";

type Reply = { status: number; body?: unknown } | Error;

/** Fetch giả phân theo model nằm trong request body (OpenAI để model trong body, không ở URL). */
function fakeFetch(replies: Record<string, Reply[]>) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(input), init: init ?? {}, body });
    const r = replies[body.model]?.shift();
    if (!r) return Promise.reject(new Error(`no reply for ${body.model}`));
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), { status: r.status }));
  };
  return { fn: fn as typeof fetch, calls };
}

function keyedFetch(byKey: Record<string, Reply[]>) {
  const calls: { key: string; model: string }[] = [];
  const fn = (_input: string | URL | Request, init?: RequestInit) => {
    const key = ((init?.headers as Record<string, string>)["authorization"] ?? "").replace("Bearer ", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ key, model: body.model });
    const r = byKey[`${key}/${body.model}`]?.shift();
    if (!r) return Promise.reject(new Error(`no reply for ${key}/${body.model}`));
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

const ok = (text: string) => ({ status: 200, body: { choices: [{ message: { content: text } }] } });
const vec = (n: number, v = 0.1) => Array.from({ length: n }, () => v);

Deno.test("generate posts chat completions with reasoning off and returns content", async () => {
  const f = fakeFetch({ m1: [ok("hi")] });
  const r = await createOpenAi({ apiKeys: ["k"], store: store(["m1"]).s, fetch: f.fn }).generate("draft", "p");
  assertEquals(r, { text: "hi", model: "m1" });
  assertEquals(f.calls[0].url, "https://api.openai.com/v1/chat/completions");
  assertEquals(f.calls[0].body.model, "m1");
  assertEquals(f.calls[0].body.messages, [{ role: "user", content: "p" }]);
  assertEquals(f.calls[0].body.reasoning_effort, "none");
  assertEquals("temperature" in f.calls[0].body, false);
  assertEquals("response_format" in f.calls[0].body, false);
});

Deno.test("generate sends the key as a Bearer header, never in the URL", async () => {
  const f = fakeFetch({ m1: [ok("x")] });
  await createOpenAi({ apiKeys: ["secret-key"], store: store(["m1"]).s, fetch: f.fn }).generate("draft", "p");
  assertEquals((f.calls[0].init.headers as Record<string, string>)["authorization"], "Bearer secret-key");
  assertEquals(f.calls[0].url.includes("secret-key"), false);
});

Deno.test("generate converts a Gemini-style schema and sends temperature when given", async () => {
  const f = fakeFetch({ m1: [ok("{}")] });
  const schema = {
    type: "OBJECT",
    properties: {
      items: { type: "ARRAY", items: { type: "OBJECT", properties: { i: { type: "INTEGER" }, en: { type: "STRING" } }, required: ["i", "en"] } },
      note: { type: "STRING" },
    },
    required: ["items"],
    propertyOrdering: ["items", "note"],
  };
  await createOpenAi({ apiKeys: ["k"], store: store(["m1"]).s, fetch: f.fn }).generate("translate", "p", { schema, temperature: 1.2 });
  assertEquals(f.calls[0].body.temperature, 1.2);
  assertEquals(f.calls[0].body.response_format, {
    type: "json_schema",
    json_schema: {
      name: "response",
      strict: false,
      schema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, en: { type: "string" } }, required: ["i", "en"] } },
          note: { type: "string" },
        },
        required: ["items"],
      },
    },
  });
});

Deno.test("toOpenAiJsonSchema leaves an already-lowercase schema intact", () => {
  const schema = { type: "object", properties: { needs_polish: { type: "boolean" }, reason: { type: "string" } }, required: ["needs_polish"] };
  assertEquals(toOpenAiJsonSchema(schema), schema);
});

Deno.test("generate falls back on 429 then succeeds, logging both attempts", async () => {
  const f = fakeFetch({ m1: [{ status: 429 }, { status: 429 }], m2: [ok("hi")] });
  const { s, log } = store(["m1", "m2"]);
  const r = await createOpenAi({ apiKeys: ["k1", "k2"], store: s, fetch: f.fn }).generate("draft", "p");
  assertEquals(r, { text: "hi", model: "m2" });
  assertEquals(log, [["m1", "draft", true], ["m1", "draft", true], ["m2", "draft", false]]);
});

Deno.test("generate falls back on 404, 503 and network error", async () => {
  const f = fakeFetch({ m1: [{ status: 404 }], m2: [{ status: 503 }], m3: [new Error("reset")], m4: [ok("x")] });
  const r = await createOpenAi({ apiKeys: ["k"], store: store(["m1", "m2", "m3", "m4"]).s, fetch: f.fn }).generate("verify", "p");
  assertEquals(r.model, "m4");
});

Deno.test("generate throws immediately on 400 and AiUnavailable when everything fails", async () => {
  const f = fakeFetch({ m1: [{ status: 400, body: { error: { message: "bad" } } }], m2: [ok("x")] });
  const err = await assertRejects(() => createOpenAi({ apiKeys: ["k"], store: store(["m1", "m2"]).s, fetch: f.fn }).generate("draft", "p"));
  assertEquals(err instanceof AiUnavailable, false);
  assertEquals(f.calls.length, 1);

  const f2 = fakeFetch({ m1: [{ status: 429 }], m2: [{ status: 500 }] });
  const err2 = await assertRejects(() => createOpenAi({ apiKeys: ["k"], store: store(["m1", "m2"]).s, fetch: f2.fn }).generate("draft", "p"));
  assertEquals((err2 as AiUnavailable).code, "AI_UNAVAILABLE");
});

Deno.test("429 and 401 rotate to the next key on the same model; the working key goes first next time", async () => {
  const f = keyedFetch({ "k1/m1": [{ status: 429 }], "k2/m1": [ok("a"), ok("b")] });
  const ai = createOpenAi({ apiKeys: ["k1", "k2"], store: store(["m1"]).s, fetch: f.fn });
  assertEquals((await ai.generate("draft", "p")).text, "a");
  assertEquals((await ai.generate("draft", "p")).text, "b");
  assertEquals(f.calls.map((c) => c.key), ["k1", "k2", "k2"]);

  const f2 = keyedFetch({ "k1/m1": [{ status: 401 }], "k2/m1": [ok("from k2")] });
  const r2 = await createOpenAi({ apiKeys: ["k1", "k2"], store: store(["m1"]).s, fetch: f2.fn }).generate("draft", "p");
  assertEquals(r2.text, "from k2");
});

Deno.test("embed batches, asks for 768 dimensions and restores index order", async () => {
  const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
  const reply = (from: number, n: number) => ({
    status: 200,
    // Cố tình trả ngược thứ tự index để khẳng định client sắp lại đúng.
    body: { data: Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, embedding: vec(768, from + (n - 1 - i)) })) },
  });
  const f = fakeFetch({ e1: [reply(0, 100), reply(100, 50)] });
  const out = await createOpenAi({ apiKeys: ["k"], store: store(["e1"]).s, fetch: f.fn }).embed(texts, "query");
  assertEquals(f.calls.length, 2);
  assertEquals(f.calls[0].url, "https://api.openai.com/v1/embeddings");
  assertEquals(f.calls[0].body.dimensions, 768);
  assertEquals(f.calls[0].body.input.length, 100);
  assertEquals(out.length, 150);
  assertEquals(out[0][0], 0);
  assertEquals(out[149][0], 149);
});

Deno.test("embed rejects a vector with the wrong dimensionality", async () => {
  const f = fakeFetch({ e1: [{ status: 200, body: { data: [{ index: 0, embedding: vec(10) }] } }] });
  const err = await assertRejects(() => createOpenAi({ apiKeys: ["k"], store: store(["e1"]).s, fetch: f.fn }).embed(["t"], "document"));
  assertEquals(String(err).includes("768"), true);
});

Deno.test("logUsage failure does not break generate", async () => {
  const f = fakeFetch({ m1: [ok("fine")] });
  const r = await createOpenAi({ apiKeys: ["k"], store: store(["m1"], { failLog: true }).s, fetch: f.fn }).generate("draft", "p");
  assertEquals(r.text, "fine");
});

Deno.test("trace: every attempt is traced, the successful one carries token usage", async () => {
  const events: AiTraceEvent[] = [];
  const okUsage = { status: 200, body: { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } } };
  const f = fakeFetch({ m1: [{ status: 429 }], m2: [okUsage] });
  const ai = createOpenAi({ apiKeys: ["k"], store: store(["m1", "m2"]).s, fetch: f.fn, trace: (e) => { events.push(e); } });
  const r = await ai.generate("draft", "p");
  assertEquals(r.text, "hi");
  assertEquals(events.length, 2);
  assertEquals(events[0].status, 429);
  assertEquals(events[0].model, "m1");
  assertEquals(events[0].attempt, 1);
  assertEquals(events[0].promptTokens, undefined);
  assertEquals(events[1].status, 200);
  assertEquals(events[1].model, "m2");
  assertEquals(events[1].attempt, 2);
  assertEquals(events[1].promptTokens, 120);
  assertEquals(events[1].completionTokens, 30);
  assertEquals(events[1].totalTokens, 150);
  assertEquals(typeof events[1].durationMs, "number");
});

Deno.test("trace: total failure ends with an error event", async () => {
  const events: AiTraceEvent[] = [];
  const f = fakeFetch({ m1: [{ status: 500 }] });
  const ai = createOpenAi({ apiKeys: ["k"], store: store(["m1"]).s, fetch: f.fn, trace: (e) => { events.push(e); } });
  await assertRejects(() => ai.generate("draft", "p"));
  const last = events[events.length - 1];
  assertEquals(last.error !== undefined, true);
  assertEquals(last.status, 500);
});

Deno.test("trace: a throwing sink never breaks the call; embed attempts are traced with tokens", async () => {
  const events: AiTraceEvent[] = [];
  const f = fakeFetch({ e1: [{ status: 200, body: { data: [{ index: 0, embedding: vec(768) }], usage: { prompt_tokens: 7, total_tokens: 7 } } }] });
  const ai = createOpenAi({
    apiKeys: ["k"],
    store: store(["e1"]).s,
    fetch: f.fn,
    trace: (e) => { events.push(e); throw new Error("sink down"); },
  });
  const out = await ai.embed(["t"], "query");
  assertEquals(out.length, 1);
  assertEquals(events.length, 1);
  assertEquals(events[0].task, "embed");
  assertEquals(events[0].promptTokens, 7);
});
