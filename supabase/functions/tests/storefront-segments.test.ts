import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createCrispClient,
  CrispError,
  crispFromEnv,
  STOREFRONT_WATCH_SEGMENT,
  type CrispClient,
} from "../_shared/crisp.ts";
import type { StorefrontSegmentCandidate } from "../_shared/db.ts";
import type { StorefrontStoreStatus } from "../_shared/storefront.ts";
import { handleStorefrontSegments, runStorefrontSegments, withStorefrontSegment } from "../copilot/storefront-segments.ts";
import { makeDeps, WS } from "./fakes.ts";

// ---------- merge thuần ----------

Deno.test("withStorefrontSegment: gắn thêm ở cuối, giữ nguyên segment lạ + thứ tự; đã có thì không nhân đôi", () => {
  assertEquals(withStorefrontSegment([], true), [STOREFRONT_WATCH_SEGMENT]);
  assertEquals(withStorefrontSegment(["vip", "billing"], true), ["vip", "billing", STOREFRONT_WATCH_SEGMENT]);
  assertEquals(withStorefrontSegment(["vip", STOREFRONT_WATCH_SEGMENT], true), ["vip", STOREFRONT_WATCH_SEGMENT]);
});

Deno.test("withStorefrontSegment: gỡ chỉ gỡ đúng segment của mình, giữ nguyên phần còn lại; không có thì giữ nguyên", () => {
  assertEquals(withStorefrontSegment(["vip", STOREFRONT_WATCH_SEGMENT, "billing"], false), ["vip", "billing"]);
  assertEquals(withStorefrontSegment([STOREFRONT_WATCH_SEGMENT], false), []);
  assertEquals(withStorefrontSegment(["vip"], false), ["vip"]);
});

// ---------- client Crisp (REST) ----------

function fakeFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(responder(url, init ?? {}));
  }) as typeof fetch;
  return { f, calls };
}
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.test("crisp client GET meta: đúng URL/method/auth Basic + tier plugin; trích segments, lọc phần tử không phải string", async () => {
  const { f, calls } = fakeFetch(() => jsonRes({ error: false, data: { segments: ["vip", STOREFRONT_WATCH_SEGMENT, 7, null] } }));
  const c = createCrispClient({ identifier: "id-x", key: "key-y", fetch: f });
  const segs = await c.getConversationSegments("ws1", "s1");
  assertEquals(segs, ["vip", STOREFRONT_WATCH_SEGMENT]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.crisp.chat/v1/website/ws1/conversation/s1/meta");
  assertEquals(calls[0].init.method, "GET");
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers["authorization"], `Basic ${btoa("id-x:key-y")}`);
  assertEquals(headers["x-crisp-tier"], "plugin");
});

Deno.test("crisp client PATCH meta: ghi đúng body {segments} đã merge; HTTP lỗi hoặc error:true đều ném CrispError", async () => {
  const { f, calls } = fakeFetch(() => jsonRes({ error: false, data: {} }));
  const c = createCrispClient({ identifier: "id-x", key: "key-y", fetch: f });
  await c.setConversationSegments("ws1", "s1", ["vip", STOREFRONT_WATCH_SEGMENT]);
  assertEquals(calls[0].init.method, "PATCH");
  assertEquals(JSON.parse(String(calls[0].init.body)), { segments: ["vip", STOREFRONT_WATCH_SEGMENT] });

  const c500 = createCrispClient({ identifier: "i", key: "k", fetch: fakeFetch(() => jsonRes({}, 500)).f });
  await assertRejects(() => c500.getConversationSegments("ws1", "s1"), CrispError);
  const cErr = createCrispClient({ identifier: "i", key: "k", fetch: fakeFetch(() => jsonRes({ error: true, reason: "nope" })).f });
  await assertRejects(() => cErr.setConversationSegments("ws1", "s1", []), CrispError);
});

Deno.test("crispFromEnv: thiếu một trong hai secret → null; đủ cả hai → có client", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assertEquals(crispFromEnv(env({})), null);
  assertEquals(crispFromEnv(env({ CRISP_PLUGIN_IDENTIFIER: "id" })), null);
  assertEquals(crispFromEnv(env({ CRISP_PLUGIN_KEY: "k" })), null);
  assert(crispFromEnv(env({ CRISP_PLUGIN_IDENTIFIER: "id", CRISP_PLUGIN_KEY: "k" })) !== null);
});

// ---------- job đồng bộ segment ----------

const status = (shop: string, over: Partial<StorefrontStoreStatus> = {}): StorefrontStoreStatus => ({
  website_id: "ws1", shop, watched: true,
  open_critical: 1, open_high: 0, open_medium: 0, open_low: 0, open_total: 1,
  worst_severity: "critical", last_good_check: "2026-10-22", fetched_at: "2026-10-23T01:00:00.000Z",
  ...over,
});
const cand = (session_id: string, shop: string | null, segments: string[] = []): StorefrontSegmentCandidate => ({ session_id, shop, segments });

function segHarness(opts: {
  statuses?: StorefrontStoreStatus[];
  candidates?: StorefrontSegmentCandidate[];
  crispState?: Record<string, string[]>;
  failGetOn?: string[];
  failPatchOn?: string[];
  wsOver?: Record<string, unknown> | null;
  maxChanges?: number;
} = {}) {
  const state = new Map(Object.entries(opts.crispState ?? {}).map(([k, v]) => [k, [...v]]));
  const gets: string[] = [];
  const patches: { sessionId: string; segments: string[] }[] = [];
  const crisp: CrispClient = {
    getConversationSegments: (_w, sid) => {
      gets.push(sid);
      if ((opts.failGetOn ?? []).includes(sid)) return Promise.reject(new CrispError("Crisp API GET meta lỗi (HTTP 500)"));
      return Promise.resolve([...(state.get(sid) ?? [])]);
    },
    setConversationSegments: (_w, sid, segs) => {
      if ((opts.failPatchOn ?? []).includes(sid)) return Promise.reject(new CrispError("Crisp API PATCH meta lỗi (HTTP 500)"));
      patches.push({ sessionId: sid, segments: [...segs] });
      state.set(sid, [...segs]);
      return Promise.resolve();
    },
    getConversationCustomData: () => Promise.resolve(null),
    setConversationCustomData: () => Promise.resolve(),
  };
  const made = makeDeps({
    db: {
      getWorkspace: () => Promise.resolve(opts.wsOver === null ? null : { ...WS, jira_project: "TNT", storefront_watch: true, ...(opts.wsOver ?? {}) }),
      listStorefrontStoreStatus: () => Promise.resolve(opts.statuses ?? []),
      getStorefrontSegmentCandidates: () => Promise.resolve(opts.candidates ?? []),
    },
  });
  const deps = { db: made.deps.db, crisp, ...(opts.maxChanges !== undefined ? { maxChanges: opts.maxChanges } : {}) };
  return { deps, gets, patches, state };
}

Deno.test("segments: gắn mới cho conversation thuộc store có lỗi mở — GET kiểm chứng trước, PATCH danh sách đã merge", async () => {
  const h = segHarness({
    statuses: [status("a.myshopify.com")],
    candidates: [cand("s1", "a.myshopify.com")],
    crispState: { s1: [] },
  });
  const r = await runStorefrontSegments(h.deps, "ws1");
  assertEquals(r, { tagged: 1, untagged: 0, unchanged: 0, failed: 0, backlog: 0, skipped: null });
  assertEquals(h.gets, ["s1"]);
  assertEquals(h.patches, [{ sessionId: "s1", segments: [STOREFRONT_WATCH_SEGMENT] }]);
});

Deno.test("segments: merge đi từ bản THẬT trên Crisp (không phải mirror) — segment CS vừa gắn tay được giữ nguyên khi gắn thêm", async () => {
  // Mirror DB chưa có gì (ingest chưa kịp), nhưng trên Crisp thật CS đã có
  // sẵn 2 segment của họ. PATCH ghi đè cả trường segments: nếu merge từ
  // mirror sẽ XOÁ mất segment của CS — ca này khoá đúng lỗi đó.
  const h = segHarness({
    statuses: [status("a.myshopify.com")],
    candidates: [cand("s1", "a.myshopify.com")],
    crispState: { s1: ["vip", "billing"] },
  });
  const r = await runStorefrontSegments(h.deps, "ws1");
  assertEquals(r.tagged, 1);
  assertEquals(h.patches, [{ sessionId: "s1", segments: ["vip", "billing", STOREFRONT_WATCH_SEGMENT] }]);
});

Deno.test("segments: store hết lỗi (open_total = 0) → gỡ segment, giữ nguyên segment lạ của CS ở cả hai phía", async () => {
  const h = segHarness({
    statuses: [status("a.myshopify.com", { open_critical: 0, open_total: 0, worst_severity: null })],
    candidates: [cand("s1", "a.myshopify.com", ["vip", STOREFRONT_WATCH_SEGMENT])],
    crispState: { s1: ["vip", STOREFRONT_WATCH_SEGMENT, "billing"] },
  });
  const r = await runStorefrontSegments(h.deps, "ws1");
  assertEquals([r.tagged, r.untagged], [0, 1]);
  assertEquals(h.patches, [{ sessionId: "s1", segments: ["vip", "billing"] }]);
});

Deno.test("segments: store không còn được theo dõi (watched = false) hoặc vắng khỏi bản chụp → gỡ segment", async () => {
  const h = segHarness({
    statuses: [status("a.myshopify.com", { watched: false, open_critical: 0, open_total: 0, worst_severity: null, last_good_check: null })],
    candidates: [
      cand("s1", "a.myshopify.com", [STOREFRONT_WATCH_SEGMENT]),
      cand("s2", "gone.myshopify.com", [STOREFRONT_WATCH_SEGMENT]), // shop không còn trong bản chụp
      cand("s3", null, [STOREFRONT_WATCH_SEGMENT]), // conversation không còn domain
    ],
    crispState: { s1: [STOREFRONT_WATCH_SEGMENT], s2: [STOREFRONT_WATCH_SEGMENT], s3: [STOREFRONT_WATCH_SEGMENT] },
  });
  const r = await runStorefrontSegments(h.deps, "ws1");
  assertEquals(r.untagged, 3);
  assertEquals(h.patches.map((p) => p.segments), [[], [], []]);
});

Deno.test("segments: không có diff theo mirror → 0 lời gọi Crisp (kể cả GET)", async () => {
  const h = segHarness({
    statuses: [status("a.myshopify.com"), status("b.myshopify.com", { open_critical: 0, open_total: 0, worst_severity: null })],
    candidates: [
      cand("s1", "a.myshopify.com", [STOREFRONT_WATCH_SEGMENT]), // đã gắn + store có lỗi → đúng
      cand("s2", "b.myshopify.com", []), // chưa gắn + store hết lỗi → đúng
    ],
    crispState: { s1: [STOREFRONT_WATCH_SEGMENT], s2: [] },
  });
  const r = await runStorefrontSegments(h.deps, "ws1");
  assertEquals(r, { tagged: 0, untagged: 0, unchanged: 2, failed: 0, backlog: 0, skipped: null });
  assertEquals(h.gets, []);
  assertEquals(h.patches, []);
});

Deno.test("segments: chạy 2 lần với mirror đứng yên (webhook chưa về) → lần 2 có GET kiểm chứng nhưng 0 PATCH", async () => {
  const h = segHarness({
    statuses: [status("a.myshopify.com")],
    candidates: [cand("s1", "a.myshopify.com")], // mirror luôn trả [] — mô phỏng mirror chưa cập nhật
    crispState: { s1: [] },
  });
  const r1 = await runStorefrontSegments(h.deps, "ws1");
  assertEquals(r1.tagged, 1);
  const r2 = await runStorefrontSegments(h.deps, "ws1");
  assertEquals([r2.tagged, r2.untagged, r2.unchanged], [0, 0, 1]);
  assertEquals(h.patches.length, 1); // tổng số lần ghi qua 2 lượt vẫn là 1
});

Deno.test("segments: workspace cờ storefront_watch TẮT (kể cả jira_project = TNT) → bỏ qua, KHÔNG một lời gọi Crisp nào", async () => {
  const h = segHarness({
    statuses: [status("a.myshopify.com")],
    candidates: [cand("s1", "a.myshopify.com")],
    crispState: { s1: [] },
    wsOver: { storefront_watch: false },
  });
  const r = await runStorefrontSegments(h.deps, "ws1");
  assertEquals(r.skipped, "not_transcy_workspace");
  assertEquals(h.gets, []);
  assertEquals(h.patches, []);
});

Deno.test("segments: workspace không tồn tại → skipped unknown_workspace; thiếu credential Crisp → skipped unconfigured, không lỗi sập", async () => {
  const h1 = segHarness({ wsOver: null });
  const r1 = await runStorefrontSegments(h1.deps, "ws1");
  assertEquals(r1.skipped, "unknown_workspace");
  assertEquals(h1.gets, []);

  const h2 = segHarness({ statuses: [status("a.myshopify.com")], candidates: [cand("s1", "a.myshopify.com")] });
  const r2 = await handleStorefrontSegments({ website_id: "ws1" }, { db: h2.deps.db, crisp: null });
  assertEquals(r2.status, 200);
  assertEquals((r2.body as { skipped: string | null }).skipped, "unconfigured");

  const r3 = await handleStorefrontSegments({}, { db: h2.deps.db, crisp: null });
  assertEquals(r3.status, 400);
});

Deno.test("segments: lỗi ở một conversation (GET hoặc PATCH) chỉ tính failed, các conversation còn lại vẫn xử lý", async () => {
  const h = segHarness({
    statuses: [status("a.myshopify.com")],
    candidates: [cand("s1", "a.myshopify.com"), cand("s2", "a.myshopify.com"), cand("s3", "a.myshopify.com")],
    crispState: { s1: [], s2: [], s3: [] },
    failGetOn: ["s1"],
    failPatchOn: ["s2"],
  });
  const r = await runStorefrontSegments(h.deps, "ws1");
  assertEquals([r.tagged, r.failed], [1, 2]); // s3 vẫn gắn được
  assertEquals(h.patches.map((p) => p.sessionId), ["s3"]);
});

Deno.test("segments: vượt trần PATCH mỗi lượt → phần cần ghi còn lại nằm ở backlog; lượt sau (mirror vẫn cũ) vẫn thoát được backlog", async () => {
  const h = segHarness({
    statuses: [status("a.myshopify.com")],
    candidates: [cand("s1", "a.myshopify.com"), cand("s2", "a.myshopify.com"), cand("s3", "a.myshopify.com")],
    crispState: { s1: [], s2: [], s3: [] },
    maxChanges: 2,
  });
  const r1 = await runStorefrontSegments(h.deps, "ws1");
  assertEquals([r1.tagged, r1.backlog], [2, 1]);
  assertEquals(h.patches.map((p) => p.sessionId), ["s1", "s2"]);
  // Lượt 2: s1/s2 đã đúng trên Crisp (GET kiểm chứng → unchanged, không ăn
  // trần), s3 được ghi nốt — backlog thoát dù mirror chưa hề cập nhật.
  const r2 = await runStorefrontSegments(h.deps, "ws1");
  assertEquals([r2.tagged, r2.backlog, r2.unchanged], [1, 0, 2]);
  assertEquals(h.patches.map((p) => p.sessionId), ["s1", "s2", "s3"]);
});

Deno.test("segments: lỗi DB giữa chừng → handler trả 200 kèm skipped error (việc nền không gãy thành 500)", async () => {
  const made = makeDeps({
    db: {
      getWorkspace: () => Promise.resolve({ ...WS, storefront_watch: true }),
      listStorefrontStoreStatus: () => Promise.reject(new Error("db down")),
    },
  });
  const r = await handleStorefrontSegments({ website_id: "ws1" }, { db: made.deps.db, crisp: { getConversationSegments: () => Promise.resolve([]), setConversationSegments: () => Promise.resolve(), setConversationCustomData: () => Promise.resolve(), getConversationCustomData: () => Promise.resolve(null) } });
  assertEquals(r.status, 200);
  assertEquals((r.body as { skipped: string | null }).skipped, "error");
});
