import { assertEquals } from "jsr:@std/assert@1";
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = "test-hook-secret";
const wf = JSON.parse(await Deno.readTextFile(new URL("./ingest-crisp.json", import.meta.url)));
const webhook = wf.nodes.find((n: { name: string }) => n.name === "Crisp Webhook");
const code: string = wf.nodes.find((n: { name: string }) => n.name === "Filter Events").parameters.jsCode
  .replace("REPLACE_CRISP_HOOK_SECRET", SECRET);

// Chạy jsCode của Code node n8n với $input/require/this.helpers giả lập.
function runFilter(headers: Record<string, string>, raw: string): Promise<unknown[]> {
  const fn = new Function("$input", "require", "Buffer", `return (async function () { ${code} }).call(this);`);
  const ctx = { helpers: { getBinaryDataBuffer: () => Promise.resolve(Buffer.from(raw)) } };
  const input = { first: () => ({ json: { headers, body: JSON.parse(raw) } }) };
  const req = (m: string) => (m === "crypto" ? { createHmac, timingSafeEqual } : null);
  return fn.call(ctx, input, req, Buffer);
}

function sign(ts: string, raw: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(`[${ts};${raw}]`).digest("hex");
}

const RAW = JSON.stringify({ website_id: "ws1", event: "message:send", data: { session_id: "session_1", content: "hi" } });
const TS = String(Math.floor(Date.now() / 1000));

Deno.test("webhook node keeps raw body for signature check", () => {
  assertEquals(webhook.parameters.options.rawBody, true);
});

Deno.test("valid Crisp signature passes the event through", async () => {
  const out = await runFilter({ "x-crisp-request-timestamp": TS, "x-crisp-signature": sign(TS, RAW) }, RAW);
  assertEquals(out, [{ json: { p_event: JSON.parse(RAW) } }]);
});

Deno.test("wrong signature is dropped", async () => {
  const out = await runFilter({ "x-crisp-request-timestamp": TS, "x-crisp-signature": sign(TS, RAW, "other") }, RAW);
  assertEquals(out, []);
});

Deno.test("missing signature headers are dropped", async () => {
  assertEquals(await runFilter({}, RAW), []);
});

Deno.test("tampered body with old signature is dropped", async () => {
  const forged = RAW.replace("hi", "bye");
  assertEquals(await runFilter({ "x-crisp-request-timestamp": TS, "x-crisp-signature": sign(TS, RAW) }, forged), []);
});

Deno.test("stale timestamp (replay) is dropped", async () => {
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  assertEquals(await runFilter({ "x-crisp-request-timestamp": old, "x-crisp-signature": sign(old, RAW) }, RAW), []);
});

Deno.test("signed but unsupported event is dropped", async () => {
  const raw = JSON.stringify({ website_id: "ws1", event: "people:profile:created", data: {} });
  assertEquals(await runFilter({ "x-crisp-request-timestamp": TS, "x-crisp-signature": sign(TS, raw) }, raw), []);
});
