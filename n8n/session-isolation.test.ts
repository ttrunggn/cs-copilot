import { assert, assertEquals } from "jsr:@std/assert@1";

// Trục cách ly giữa các chat cho hai workflow n8n xử lý theo phiên:
// copilot-refresh (một phiên / request) và crisp-sync (NHIỀU phiên / lượt quét).
// Điểm "râu ông này cắm cằm bà kia" kinh điển ở n8n là node xử lý nhiều item
// nhưng lấy session của item đầu (.first()). Các test này CHẠY THẬT jsCode
// của node Build Events / Split Conversations với $input/$ được giả lập
// nhiều item, và khẳng định mỗi event ra đời mang đúng (website_id,
// session_id, meta.data) của phiên của nó.

const readWf = async (f: string) => JSON.parse(await Deno.readTextFile(new URL(`./${f}`, import.meta.url)));
const nodeCode = (wf: { nodes: { name: string; parameters: Record<string, unknown> }[] }, name: string): string => {
  const n = wf.nodes.find((x) => x.name === name);
  assert(n, `thiếu node ${name}`);
  return String(n.parameters.jsCode ?? "");
};

/** Chạy jsCode của một Code node (đồng bộ) với $ và $input giả lập. */
function runSync(code: string, $: unknown, $input: unknown): unknown {
  const fn = new Function("$", "$input", `return (() => { ${code} })();`);
  return fn($, $input);
}

// ---------- copilot-refresh: Build Events khoá theo phiên của Verify Secret ----------

const refresh = await readWf("copilot-refresh.json");
const refreshBuild: string = nodeCode(refresh, "Build Events");

function runRefreshBuild(sessionId: string, domain: string, msgs: Record<string, unknown>[]) {
  const byName: Record<string, { json: unknown }> = {
    "Verify Secret": { json: { website_id: "ws1", session_id: sessionId } },
    "Get Conversation": {
      json: {
        data: {
          meta: { email: "a@x.io", nickname: "A", segments: [], data: { shopify_domain: domain } },
          state: "unresolved",
        },
      },
    },
    "Get Messages": { json: { data: msgs } },
  };
  const $ = (name: string) => ({ first: () => byName[name] });
  return runSync(refreshBuild, $, null) as { json: { p_events: Record<string, unknown>[] } }[];
}

Deno.test("refresh Build Events: mọi event (meta + messages) mang đúng session_id đã verify, kể cả khi message tự mang session_id khác", () => {
  const out = runRefreshBuild("session_A", "shop-a.myshopify.com", [
    { fingerprint: 11, session_id: "session_WRONG", content: "hi" },
    { fingerprint: 12, content: "yo" },
  ]);
  assertEquals(out.length, 1);
  const events = out[0].json.p_events as unknown as {
    website_id: string;
    event: string;
    data: { session_id: string; data?: { shopify_domain?: string }; fingerprint?: number };
  }[];
  assertEquals(events.length, 3);
  for (const e of events) {
    assertEquals(e.website_id, "ws1");
    assertEquals(e.data.session_id, "session_A", e.event); // message:import bị ghi đè về đúng phiên, không theo session_id tự mang
  }
  assertEquals(events[0].event, "session:meta");
  assertEquals(events[0].data.data?.shopify_domain, "shop-a.myshopify.com");
  assertEquals(events.slice(1).map((e) => e.data.fingerprint), [11, 12]);
});

Deno.test("refresh Build Events: chạy cho phiên B sau phiên A không dính domain/session của A", () => {
  const a = runRefreshBuild("session_A", "shop-a.myshopify.com", [{ fingerprint: 11 }]);
  const b = runRefreshBuild("session_B", "shop-b.myshopify.com", [{ fingerprint: 22 }]);
  const bJson = JSON.stringify(b);
  assert(bJson.includes("session_B") && bJson.includes("shop-b.myshopify.com"), bJson);
  assert(!bJson.includes("session_A") && !bJson.includes("shop-a.myshopify.com"), bJson);
  assert(JSON.stringify(a).includes("shop-a.myshopify.com"));
});

// ---------- crisp-sync: Split Conversations + Build Events với NHIỀU item ----------

const sync = await readWf("crisp-sync.json");
const splitCode: string = nodeCode(sync, "Split Conversations");
const syncBuild: string = nodeCode(sync, "Build Events");

Deno.test("crisp-sync Split Conversations: mỗi conversation ra mang đúng website fallback của item cha và meta riêng của nó", () => {
  const pages = [
    {
      json: {
        data: [
          { session_id: "session_A1", meta: { data: { shopify_domain: "a1.myshopify.com" } }, state: "unresolved" },
          { session_id: "session_A2", meta: { data: { shopify_domain: "a2.myshopify.com" } }, state: "unresolved" },
        ],
      },
    },
    { json: { data: [{ session_id: "session_B1", meta: { data: { shopify_domain: "b1.myshopify.com" } }, state: "pending" }] } },
  ];
  const $input = { all: () => pages };
  // Conversation không tự mang website_id → fallback phải theo item cha qua itemMatching(i), không phải item đầu cho mọi item.
  const $ = (name: string) => {
    assertEquals(name, "Get Workspaces");
    return { itemMatching: (i: number) => ({ json: { website_id: i === 0 ? "ws-A" : "ws-B" } }) };
  };
  const out = runSync(splitCode, $, $input) as { json: { website_id: string; session_id: string; meta: { data: { shopify_domain: string } } } }[];
  assertEquals(out.map((o) => [o.json.website_id, o.json.session_id, o.json.meta.data.shopify_domain]), [
    ["ws-A", "session_A1", "a1.myshopify.com"],
    ["ws-A", "session_A2", "a2.myshopify.com"],
    ["ws-B", "session_B1", "b1.myshopify.com"],
  ]);
});

Deno.test("crisp-sync Build Events: 2 phiên trong cùng lượt quét — p_events của mỗi item chỉ chứa session/meta/message của chính nó", () => {
  const splitItems = [
    { website_id: "ws1", session_id: "session_A", meta: { email: "a@x.io", data: { shopify_domain: "shop-a.myshopify.com" } }, state: "unresolved" },
    { website_id: "ws1", session_id: "session_B", meta: { email: "b@x.io", data: { shopify_domain: "shop-b.myshopify.com" } }, state: "unresolved" },
  ];
  const msgPages = [
    { json: { data: [{ fingerprint: 101, session_id: "session_WRONG", content: "của A" }] } },
    { json: { data: [{ fingerprint: 202, content: "của B" }, { fingerprint: 203, content: "của B 2" }] } },
  ];
  const $input = { all: () => msgPages };
  const $ = (name: string) => {
    assertEquals(name, "Split Conversations");
    return { itemMatching: (i: number) => ({ json: splitItems[i] }) };
  };
  const out = runSync(syncBuild, $, $input) as { json: { p_events: unknown[] } }[];
  assertEquals(out.length, 2);
  const [eventsA, eventsB] = out.map((o) => o.json.p_events) as {
    website_id: string;
    event: string;
    data: { session_id: string; fingerprint?: number; data?: { shopify_domain?: string } };
  }[][];
  assertEquals(eventsA.length, 2); // meta + 1 message
  assertEquals(eventsB.length, 3); // meta + 2 messages
  for (const e of eventsA) assertEquals(e.data.session_id, "session_A", e.event);
  for (const e of eventsB) assertEquals(e.data.session_id, "session_B", e.event);
  assertEquals(eventsA[0].data.data?.shopify_domain, "shop-a.myshopify.com");
  assertEquals(eventsB[0].data.data?.shopify_domain, "shop-b.myshopify.com");
  assertEquals(eventsA.slice(1).map((e) => e.data.fingerprint), [101]);
  assertEquals(eventsB.slice(1).map((e) => e.data.fingerprint), [202, 203]);
  assert(!JSON.stringify(eventsA).includes("shop-b"), "events của A không được chứa domain của B");
  assert(!JSON.stringify(eventsB).includes("shop-a"), "events của B không được chứa domain của A");
});

Deno.test("crisp-sync: các node đa-item dùng tham chiếu theo item (item/itemMatching), không dùng .first() của item đầu", () => {
  const byName = (name: string) => sync.nodes.find((n: { name: string }) => n.name === name);
  assert(syncBuild.includes("itemMatching"), syncBuild);
  assert(!syncBuild.includes(".first()"), syncBuild);
  assert(splitCode.includes("itemMatching"), splitCode);
  assert(!splitCode.includes(".first()"), splitCode);
  const ingestOps = String(byName("Ingest Operators").parameters.jsonBody ?? "");
  assert(ingestOps.includes("$('Get Workspaces').item.json.website_id"), ingestOps);
  assert(!ingestOps.includes(".first()"), ingestOps);
});

Deno.test("refresh: Get Messages lấy website/session từ Verify Secret theo tên (không theo output của Get Conversation)", () => {
  const getMsgs = refresh.nodes.find((n: { name: string }) => n.name === "Get Messages");
  const url = String(getMsgs.parameters.url ?? "");
  assert(url.includes("$('Verify Secret').first().json.website_id"), url);
  assert(url.includes("$('Verify Secret').first().json.session_id"), url);
});
