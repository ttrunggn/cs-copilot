import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

// Hook cấp website của Crisp KHÔNG được ký (chỉ plugin hook có X-Crisp-Signature),
// nên ingest được bảo vệ bằng đường dẫn webhook ngẫu nhiên và chỉ cho qua event hợp lệ.
const wf = JSON.parse(await Deno.readTextFile(new URL("./ingest-crisp.json", import.meta.url)));
const node = (name: string) => wf.nodes.find((n: { name: string }) => n.name === name);
const filter: string = node("Filter Events").parameters.jsCode;

function run(body: unknown, path = "crisp-ingest-b3d3d4eb3bc264f3222f0018"): Promise<unknown[]> {
  const fn = new Function("$input", "$", `return (async function () { ${filter} }).call(this);`);
  const $ = (name: string) => (name === "Crisp Webhook" ? { params: { path } } : null);
  return fn.call({}, { first: () => ({ json: { headers: {}, body } }) }, $);
}

const EVENT = { website_id: "ws1", event: "message:send", data: { session_id: "session_1", content: "hi" } };

Deno.test("ingest is Webhook → Filter Events → Ingest Event (no signature nodes)", () => {
  assertEquals(wf.nodes.map((n: { name: string }) => n.name), ["Crisp Webhook", "Filter Events", "Ingest Event"]);
});

Deno.test("webhook path carries a random-secret placeholder", () => {
  assertEquals(node("Crisp Webhook").parameters.path, "crisp-ingest-REPLACE-WITH-RANDOM");
});

Deno.test("no Code node uses require (n8n blocks the crypto module)", () => {
  for (const n of wf.nodes) assert(!String(n.parameters.jsCode ?? "").includes("require("), n.name);
});

Deno.test("supported Crisp event passes through", async () => {
  assertEquals(await run(EVENT), [{ json: { p_event: EVENT } }]);
});

Deno.test("unsupported event is dropped", async () => {
  assertEquals(await run({ ...EVENT, event: "people:profile:created" }), []);
});

Deno.test("payload without website_id or data is dropped", async () => {
  assertEquals(await run({ event: "message:send", data: {} }), []);
  assertEquals(await run({ website_id: "ws1", event: "message:send" }), []);
});

Deno.test("non-object body is dropped", async () => {
  assertEquals(await run("garbage"), []);
});

Deno.test("unreplaced placeholder webhook path fails closed", async () => {
  await assertRejects(() => run(EVENT, "crisp-ingest-REPLACE-WITH-RANDOM"), Error, "chưa được thay");
});

Deno.test("too-short webhook path fails closed", async () => {
  await assertRejects(() => run(EVENT, "crisp-ingest-abc"), Error, "chưa được thay");
});
