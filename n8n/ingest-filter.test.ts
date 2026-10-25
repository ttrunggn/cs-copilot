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

Deno.test("ingest is Webhook → Filter Events → Ingest Event → precompute sentiment (no signature nodes)", () => {
  assertEquals(wf.nodes.map((n: { name: string }) => n.name), ["Crisp Webhook", "Filter Events", "Ingest Event", "Chuẩn bị precompute", "Precompute Sentiment"]);
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

Deno.test("session:set_data (Crisp custom data) passes through with pairs intact", async () => {
  const ev = {
    website_id: "ws1",
    event: "session:set_data",
    data: { session_id: "session_1", data: { shopify_domain: "shop-a.myshopify.com", tc_plan: "Cross-Border" } },
  };
  assertEquals(await run(ev), [{ json: { p_event: ev } }]);
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

// Ingest Event và Chuẩn bị precompute phải lấy p_event từ node Filter Events THEO TÊN,
// không từ $json trực tiếp: RPC ingest_event trả void nên node đứng sau nó nhận $json rỗng,
// còn node đứng trước nó thì nuốt mất p_event của Ingest Event. Tham chiếu theo tên thì
// thứ tự node sao cũng chạy.
Deno.test("Ingest Event body pulls p_event from Filter Events by name, not $json", () => {
  const body = String(node("Ingest Event").parameters.jsonBody ?? "");
  assert(body.includes("$('Filter Events').first().json.p_event"), body);
  assert(!body.includes("$json.p_event"), body);
});

Deno.test("precompute prep reads the event from Filter Events by name, not $json", () => {
  const code = String(node("Chuẩn bị precompute").parameters.jsCode ?? "");
  assert(code.includes("$('Filter Events').first().json.p_event"), code);
  assert(!code.includes("$json.p_event"), code);
});

Deno.test("precompute prep still works when its own input ($json) is the void RPC result", async () => {
  const code: string = node("Chuẩn bị precompute").parameters.jsCode;
  const received = { website_id: "ws1", event: "message:received", data: { session_id: "session_9" } };
  const $ = (name: string) => (name === "Filter Events" ? { first: () => ({ json: { p_event: received } }) } : null);
  const fn = new Function("$", "$json", `return (async function () { ${code} }).call(this);`);
  // $json rỗng mô phỏng output của Ingest Event (void) khi prep đứng sau nó.
  assertEquals(await fn($, {}), [{ json: { website_id: "ws1", session_id: "session_9" } }]);
  const other = { ...received, event: "message:send" };
  const $2 = (name: string) => (name === "Filter Events" ? { first: () => ({ json: { p_event: other } }) } : null);
  assertEquals(await fn($2, {}), []);
});
