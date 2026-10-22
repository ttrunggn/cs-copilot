import { assertEquals } from "jsr:@std/assert@1";
import { createN8n, DEFAULT_REFRESH_TIMEOUT_MS } from "../_shared/n8n.ts";

type Call = { url: string; init: RequestInit };

function recorder(response: () => Promise<Response>) {
  const calls: Call[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, f };
}

Deno.test("refresh ok -> stale false, sends secret and ids", async () => {
  const { calls, f } = recorder(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.refreshConversation("ws1", "session_1"), { stale: false });
  assertEquals(calls[0].url, "https://n8n.test/webhook/copilot-refresh");
  assertEquals((calls[0].init.headers as Record<string, string>)["x-copilot-secret"], "k");
  assertEquals(JSON.parse(calls[0].init.body as string), { website_id: "ws1", session_id: "session_1" });
});

Deno.test("refresh non-2xx -> stale true", async () => {
  const { f } = recorder(() => Promise.resolve(new Response("err", { status: 500 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.refreshConversation("ws1", "session_1"), { stale: true });
});

Deno.test("refresh hang -> stale true after timeout", async () => {
  const hanging = ((_u: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    )) as typeof fetch;
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: hanging, refreshTimeoutMs: 50 });
  const t0 = Date.now();
  assertEquals(await n8n.refreshConversation("ws1", "session_1"), { stale: true });
  assertEquals(Date.now() - t0 < 1000, true);
});

Deno.test("postNote prefixes robot once and returns ok", async () => {
  const { calls, f } = recorder(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.postNote("ws1", "session_1", "Tóm tắt"), true);
  assertEquals(await n8n.postNote("ws1", "session_1", "🤖 Đã có"), true);
  assertEquals(calls[0].url, "https://n8n.test/webhook/copilot-post-note");
  assertEquals(JSON.parse(calls[0].init.body as string).content, "🤖 Tóm tắt");
  assertEquals(JSON.parse(calls[1].init.body as string).content, "🤖 Đã có");
});

Deno.test("postNote network error -> false", async () => {
  const { f } = recorder(() => Promise.reject(new TypeError("network")));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.postNote("ws1", "session_1", "x"), false);
});

Deno.test("refresh 200 with empty body (n8n workflow errored) -> stale true", async () => {
  const { f } = recorder(() => Promise.resolve(new Response("", { status: 200 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.refreshConversation("ws1", "session_1"), { stale: true });
});

Deno.test("postNote 200 with empty body (n8n workflow errored) -> false", async () => {
  const { f } = recorder(() => Promise.resolve(new Response("", { status: 200 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.postNote("ws1", "session_1", "x"), false);
});

Deno.test("default refresh timeout is 5s (n8n refresh takes ~3s in production)", () => {
  assertEquals(DEFAULT_REFRESH_TIMEOUT_MS, 5000);
});

Deno.test("sendSurvey ok khi workflow trả status ok, gửi kèm agent_name", async () => {
  const { calls, f } = recorder(() => Promise.resolve(new Response('{"status":"ok"}', { status: 200 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.sendSurvey("ws1", "session_1", "Lan Nguyen"), true);
  assertEquals(calls[0].url, "https://n8n.test/webhook/send-survey");
  assertEquals(JSON.parse(calls[0].init.body as string), { website_id: "ws1", session_id: "session_1", agent_name: "Lan Nguyen" });
});

Deno.test("sendSurvey false khi workflow trả lỗi", async () => {
  const { f } = recorder(() => Promise.resolve(new Response('{"status":"error"}', { status: 200 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.sendSurvey("ws1", "session_1", ""), false);
});
