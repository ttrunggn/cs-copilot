import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

const SECRET = "test-hook-secret-123";
const wf = JSON.parse(await Deno.readTextFile(new URL("./ingest-crisp.json", import.meta.url)));
const node = (name: string) => wf.nodes.find((n: { name: string }) => n.name === name);
const prepare: string = node("Prepare Signature").parameters.jsCode;
const filter: string = node("Filter Events").parameters.jsCode;
const sign = node("Sign Body");

// Mô phỏng 3 node: Code (Prepare Signature) → Crypto (Sign Body, HMAC-SHA256 hex) → Code (Filter Events).
async function runIngest(headers: Record<string, string>, raw: string, secret = SECRET): Promise<unknown[]> {
  const fn1 = new Function("$input", `return (async function () { ${prepare} }).call(this);`);
  const ctx = { helpers: { getBinaryDataBuffer: () => Promise.resolve(Buffer.from(raw)) } };
  const prepared = await fn1.call(ctx, { first: () => ({ json: { headers, body: JSON.parse(raw) } }) }) as { json: Record<string, string> }[];
  if (prepared.length === 0) return [];
  const item = prepared[0].json;
  const signed = { ...item, [sign.parameters.dataPropertyName]: createHmac("sha256", secret).update(item.signed).digest("hex") };
  const fn2 = new Function("$input", "$", `return (async function () { ${filter} }).call(this);`);
  const $ = (name: string) => (name === "Sign Body" ? { params: { ...sign.parameters, secret } } : null);
  return fn2.call({}, { first: () => ({ json: signed }) }, $);
}

const hmac = (ts: string, raw: string, secret = SECRET) => createHmac("sha256", secret).update(`[${ts};${raw}]`).digest("hex");
const RAW = JSON.stringify({ website_id: "ws1", event: "message:send", data: { session_id: "session_1", content: "hi" } });
const TS = String(Math.floor(Date.now() / 1000));

Deno.test("no Code node uses require (n8n blocks the crypto module)", () => {
  for (const n of wf.nodes) assert(!String(n.parameters.jsCode ?? "").includes("require("), n.name);
});

Deno.test("webhook keeps raw body and Crypto node does HMAC-SHA256 hex", () => {
  assertEquals(node("Crisp Webhook").parameters.options.rawBody, true);
  assertEquals([sign.type, sign.parameters.action, sign.parameters.type, sign.parameters.encoding], ["n8n-nodes-base.crypto", "hmac", "SHA256", "hex"]);
});

Deno.test("valid Crisp signature passes the event through", async () => {
  const out = await runIngest({ "x-crisp-request-timestamp": TS, "x-crisp-signature": hmac(TS, RAW) }, RAW);
  assertEquals(out, [{ json: { p_event: JSON.parse(RAW) } }]);
});

Deno.test("wrong signature is dropped", async () => {
  assertEquals(await runIngest({ "x-crisp-request-timestamp": TS, "x-crisp-signature": hmac(TS, RAW, "other-secret-xyz") }, RAW), []);
});

Deno.test("missing signature headers are dropped", async () => {
  assertEquals(await runIngest({}, RAW), []);
});

Deno.test("tampered body with old signature is dropped", async () => {
  const forged = RAW.replace("hi", "bye");
  assertEquals(await runIngest({ "x-crisp-request-timestamp": TS, "x-crisp-signature": hmac(TS, RAW) }, forged), []);
});

Deno.test("stale timestamp (replay) is dropped", async () => {
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  assertEquals(await runIngest({ "x-crisp-request-timestamp": old, "x-crisp-signature": hmac(old, RAW) }, RAW), []);
});

Deno.test("signed but unsupported event is dropped", async () => {
  const raw = JSON.stringify({ website_id: "ws1", event: "people:profile:created", data: {} });
  assertEquals(await runIngest({ "x-crisp-request-timestamp": TS, "x-crisp-signature": hmac(TS, raw) }, raw), []);
});

Deno.test("unreplaced placeholder hook secret fails closed", async () => {
  const p = "REPLACE_CRISP_HOOK_SECRET";
  await assertRejects(
    () => runIngest({ "x-crisp-request-timestamp": TS, "x-crisp-signature": hmac(TS, RAW, p) }, RAW, p),
    Error,
    "chưa được cấu hình",
  );
});
