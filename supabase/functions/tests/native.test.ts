import { assertEquals } from "jsr:@std/assert@1";
import { sentimentFingerprint } from "../copilot/analyze.ts";
import {
  computeCrispWidgetSignature,
  formatMoodValue,
  handleNativeEvent,
  hhmmSaigon,
  isNativeEvent,
  type NativeDeps,
} from "../copilot/native.ts";
import type { Sentiment } from "../_shared/sentiment.ts";
import { CONV, fakeAi, makeDeps, msg } from "./fakes.ts";

const KEY = "plugin-key-for-tests-0123456789abcdef";

const SENTIMENT: Sentiment & { input_fp: string } = {
  score: 38,
  mood: "frustrated",
  urgency: "high",
  confidence: 0.9,
  summary: "Khách bực vì bản dịch product bị ghi đè sau khi đồng bộ",
  signals: [],
  issues: [{ summary: "Bản dịch trang product bị mất sau khi đồng bộ", evidence: "translations gone" }],
  input_fp: "fp-khong-khop",
};

function fetchEvent(itemId: string, extra: Record<string, unknown> = {}) {
  return {
    action: { type: "data", method: "fetch" },
    widget: { section_id: "khach", item_id: itemId },
    origin: { website_id: "ws1", session_id: "session_1" },
    payload: { data: {} },
    timestamp: 1761732000000,
    ...extra,
  };
}

function hookEvent(itemId: string, data: Record<string, unknown> = {}) {
  return {
    action: { type: "button", method: null },
    widget: { section_id: "action", item_id: itemId },
    origin: { website_id: "ws1", session_id: "session_1" },
    payload: { data },
    timestamp: 1761732000000,
  };
}

function nativeDeps(over: Parameters<typeof makeDeps>[0] = {}, pluginKey = "") {
  const { deps, traces } = makeDeps(over);
  const bg: Promise<unknown>[] = [];
  const nd: NativeDeps = {
    db: deps.db,
    ai: deps.ai,
    n8n: deps.n8n,
    pluginKey,
    background: (p) => {
      bg.push(p);
    },
  };
  return { nd, traces, bg, deps };
}

const NO_SIG = { signature: null, timestamp: null };

async function fetchValue(itemId: string, over: Parameters<typeof makeDeps>[0] = {}) {
  const { nd, bg } = nativeDeps(over);
  const body = fetchEvent(itemId);
  const r = await handleNativeEvent(body, JSON.stringify(body), NO_SIG, nd);
  await Promise.all(bg);
  return r;
}

Deno.test("native: isNativeEvent chỉ nhận action dạng object của Generic Widget", () => {
  assertEquals(isNativeEvent(fetchEvent("khach_tam_trang")), true);
  assertEquals(isNativeEvent(hookEvent("act_csat")), true);
  assertEquals(isNativeEvent({ website_id: "ws1", session_id: "session_1", action: "check" }), false);
  assertEquals(isNativeEvent({ action: { type: "other" }, widget: { item_id: "x" } }), false);
  assertEquals(isNativeEvent(null), false);
  assertEquals(isNativeEvent("chuỗi"), false);
});

Deno.test("native fetch: tâm trạng có sentiment → điểm + mood + khẩn cao; tóm tắt và vấn đề lấy từ cùng dòng", async () => {
  const over = { db: { getSentiment: () => Promise.resolve(SENTIMENT) } };
  const r1 = await fetchValue("khach_tam_trang", over);
  assertEquals(r1.status, 200);
  assertEquals(r1.body, { data: { value: "38/100 · Đang bực · Khẩn: cao" } });
  const r2 = await fetchValue("khach_tom_tat", over);
  assertEquals(r2.body, { data: { value: "Khách bực vì bản dịch product bị ghi đè sau khi đồng bộ" } });
  const r3 = await fetchValue("khach_van_de", over);
  assertEquals(r3.body, { data: { value: "Bản dịch trang product bị mất sau khi đồng bộ" } });
});

Deno.test("native fetch: urgency không cao thì không gắn 'Khẩn: cao'", async () => {
  const s: Sentiment & { input_fp: string } = { ...SENTIMENT, score: 50, mood: "neutral", urgency: "medium" };
  const r = await fetchValue("khach_tam_trang", { db: { getSentiment: () => Promise.resolve(s) } });
  assertEquals(r.body, { data: { value: "50/100 · Trung tính" } });
  assertEquals(formatMoodValue({ ...s, score: 88, mood: "happy", urgency: "low" }), "88/100 · Rất vui");
});

Deno.test("native fetch: chưa có sentiment → 'Chưa phân tích', tóm tắt/vấn đề là '—'", async () => {
  const r1 = await fetchValue("khach_tam_trang");
  assertEquals(r1.body, { data: { value: "Chưa phân tích" } });
  const r2 = await fetchValue("khach_tom_tat");
  assertEquals(r2.body, { data: { value: "—" } });
  const r3 = await fetchValue("khach_van_de");
  assertEquals(r3.body, { data: { value: "—" } });
});

Deno.test("native fetch: sentiment còn tươi (fingerprint khớp) thì KHÔNG kích analyze nền", async () => {
  const messages = [msg("user", "a", 1), msg("operator", "b", 2), msg("user", "c", 3)];
  const fp = await sentimentFingerprint(messages);
  const { ai, calls } = fakeAi({});
  const { deps } = makeDeps({ messages, ai, db: { getSentiment: () => Promise.resolve({ ...SENTIMENT, input_fp: fp }) } });
  const bg: Promise<unknown>[] = [];
  const body = fetchEvent("khach_tam_trang");
  const r = await handleNativeEvent(body, JSON.stringify(body), NO_SIG, { db: deps.db, ai: deps.ai, n8n: deps.n8n, background: (p) => bg.push(p) });
  assertEquals(r.status, 200);
  await Promise.all(bg);
  assertEquals(calls.length, 0); // cache tươi: không một lần gọi AI nào bị kích
});

Deno.test("native fetch: tin đang chờ đếm tin khách chưa được CS trả lời", async () => {
  const r1 = await fetchValue("khach_tin_cho");
  assertEquals(r1.body, { data: { value: "1 tin" } }); // fake messages: user, operator, user
  const r2 = await fetchValue("khach_tin_cho", { messages: [msg("operator", "x", 1), msg("user", "a", 2), msg("user", "b", 3)] });
  assertEquals(r2.body, { data: { value: "2 tin" } });
});

Deno.test("native fetch: CSAT chưa gửi / đã gửi kèm giờ Asia/Saigon", async () => {
  const r1 = await fetchValue("tt_csat");
  assertEquals(r1.body, { data: { value: "Chưa gửi" } });
  const r2 = await fetchValue("tt_csat", {
    db: { getCsatSend: () => Promise.resolve({ sent_by: "op-lan", sent_at: "2026-10-15T03:05:00+00:00" }) },
  });
  assertEquals(r2.body, { data: { value: "Đã gửi 10:05" } }); // 03:05 UTC = 10:05 +07
  assertEquals(hhmmSaigon("2026-10-15T03:05:00+00:00"), "10:05");
  assertEquals(hhmmSaigon("không-phải-ngày"), "");
});

Deno.test("native fetch: Review chưa xin / đã xin (nguồn outputs kind review)", async () => {
  const r1 = await fetchValue("tt_review");
  assertEquals(r1.body, { data: { value: "Chưa xin" } });
  const r2 = await fetchValue("tt_review", {
    db: { getReviewSend: () => Promise.resolve({ sent_at: "2026-10-15T03:05:00+00:00" }) },
  });
  assertEquals(r2.body, { data: { value: "Đã xin 10:05" } });
});

Deno.test("native fetch: Storefront theo cổng workspace + bản chụp sweep", async () => {
  // Workspace mặc định của fake: storefront_watch = false → Không áp dụng.
  const r0 = await fetchValue("tt_storefront");
  assertEquals(r0.body, { data: { value: "Không áp dụng" } });

  const wsOn = { ...CONV, custom_data: { shopify_domain: "shop.myshopify.com" } };
  const base = {
    getWorkspace: () => Promise.resolve({ website_id: "ws1", name: "App A", topics: [], default_profile: {}, jira_project: null, storefront_watch: true, review_link: null }),
    getConversation: () => Promise.resolve(wsOn),
  };
  const snap = (watched: boolean, open_total: number) => ({
    getStorefrontStoreStatus: () => Promise.resolve({
      website_id: "ws1", shop: "shop.myshopify.com", watched,
      open_critical: 0, open_high: 0, open_medium: 0, open_low: 0, open_total,
      worst_severity: null, last_good_check: null, fetched_at: "2026-10-15T03:00:00+00:00",
    }),
  });
  const r1 = await fetchValue("tt_storefront", { db: { ...base, ...snap(true, 3) } });
  assertEquals(r1.body, { data: { value: "3 lỗi" } });
  const r2 = await fetchValue("tt_storefront", { db: { ...base, ...snap(true, 0) } });
  assertEquals(r2.body, { data: { value: "Không có lỗi" } });
  const r3 = await fetchValue("tt_storefront", { db: { ...base, ...snap(false, 3) } });
  assertEquals(r3.body, { data: { value: "Không áp dụng" } });
});

Deno.test("native fetch: Jira không có / có N ticket", async () => {
  const r1 = await fetchValue("tt_jira");
  assertEquals(r1.body, { data: { value: "Không có" } });
  const link = {
    website_id: "ws1", session_id: "session_1", issue_key: "TNT-1",
    url: "https://firegroup.atlassian.net/browse/TNT-1", silent_baseline: false,
    last_seen_status: null, last_seen_comment_at: null,
  };
  const r2 = await fetchValue("tt_jira", { db: { getJiraRows: () => Promise.resolve([{ link, issue: null }]) } });
  assertEquals(r2.body, { data: { value: "1 ticket" } });
});

Deno.test("native fetch: item lạ / thiếu origin → vẫn 200 với value rỗng (Crisp khỏi retry)", async () => {
  const { nd } = nativeDeps();
  const body = fetchEvent("item_khong_ton_tai");
  const r1 = await handleNativeEvent(body, JSON.stringify(body), NO_SIG, nd);
  assertEquals(r1.status, 200);
  assertEquals(r1.body, { data: { value: "" } });
  const noOrigin = { action: { type: "data", method: "fetch" }, widget: { section_id: "khach", item_id: "khach_tam_trang" }, payload: { data: {} } };
  const r2 = await handleNativeEvent(noOrigin, JSON.stringify(noOrigin), NO_SIG, nd);
  assertEquals(r2.status, 200);
  assertEquals(r2.body, { data: { value: "" } });
});

Deno.test("native: chữ ký đúng → qua; sai → 401; vắng header → qua + trace cờ unsigned", async () => {
  const body = fetchEvent("khach_tin_cho");
  const raw = JSON.stringify(body);
  const ts = "1761732000";
  const sig = await computeCrispWidgetSignature(KEY, ts, raw);

  const ok = nativeDeps({}, KEY);
  const r1 = await handleNativeEvent(body, raw, { signature: sig, timestamp: ts }, ok.nd);
  assertEquals(r1.status, 200);

  const bad = nativeDeps({}, KEY);
  const r2 = await handleNativeEvent(body, raw, { signature: "0".repeat(64), timestamp: ts }, bad.nd);
  assertEquals(r2.status, 401);

  const unsigned = nativeDeps({}, KEY);
  const r3 = await handleNativeEvent(body, raw, NO_SIG, unsigned.nd);
  assertEquals(r3.status, 200);
  const timing = unsigned.traces.find((t) => t.kind === "timing" && t.action === "native_fetch");
  assertEquals((timing?.detail as { unsigned?: boolean } | null)?.unsigned, true);
  assertEquals(timing?.flow_id?.startsWith("native-khach_tin_cho-"), true);
});

/** Fake csat_survey_sends có trạng thái — cùng mô phỏng claim nguyên tử như survey.test.ts. */
function fakeCsatDb() {
  let row: { sent_by: string; sent_at: string } | null = null;
  return {
    db: {
      getCsatSend: () => Promise.resolve(row),
      recordCsatSend: () => {
        if (row) return Promise.resolve(null);
        row = { sent_by: "op-lan", sent_at: new Date().toISOString() };
        return Promise.resolve({ sent_at: row.sent_at });
      },
      releaseCsatSend: () => (row = null, Promise.resolve()),
    },
  };
}

Deno.test("native hook CSAT: gửi ngay qua runSurvey; bấm lại trong cửa sổ 30s không gửi trùng", async () => {
  const csat = fakeCsatDb();
  let sends = 0;
  const { deps } = makeDeps({
    db: { ...csat.db, getOperatorIdByEmail: () => Promise.resolve("op-lan") },
  });
  deps.n8n.sendSurvey = () => (sends++, Promise.resolve(true));
  const nd: NativeDeps = { db: deps.db, ai: deps.ai, n8n: deps.n8n, pluginKey: "" };
  const ev = hookEvent("act_csat", { operator_email: "lan@firegroup.io" });
  const r1 = await handleNativeEvent(ev, JSON.stringify(ev), NO_SIG, nd);
  assertEquals(r1.status, 200);
  assertEquals(r1.body, {});
  assertEquals(sends, 1);
  const r2 = await handleNativeEvent(ev, JSON.stringify(ev), NO_SIG, nd);
  assertEquals(r2.status, 200);
  assertEquals(sends, 1); // claim + cửa sổ chống bấm đúp của runSurvey chặn lần hai
});

Deno.test("native hook CSAT: operator email lạ (không thuộc workspace) → không gửi, vẫn 200", async () => {
  let sends = 0;
  const { deps } = makeDeps({
    db: { getOperatorIdByEmail: () => Promise.resolve("op-ngoai"), isOperatorMember: () => Promise.resolve(false) },
  });
  deps.n8n.sendSurvey = () => (sends++, Promise.resolve(true));
  const nd: NativeDeps = { db: deps.db, ai: deps.ai, n8n: deps.n8n, pluginKey: "" };
  const ev = hookEvent("act_csat", { operator_email: "ngoai@x.io" });
  const r = await handleNativeEvent(ev, JSON.stringify(ev), NO_SIG, nd);
  assertEquals(r.status, 200);
  assertEquals(sends, 0);
});

Deno.test("native: sự kiện nút không phải hook CSAT → 200 {} và không gửi gì", async () => {
  let sends = 0;
  const { deps, traces } = makeDeps();
  deps.n8n.sendSurvey = () => (sends++, Promise.resolve(true));
  const nd: NativeDeps = { db: deps.db, ai: deps.ai, n8n: deps.n8n, pluginKey: "" };
  const ev = hookEvent("act_draft");
  const r = await handleNativeEvent(ev, JSON.stringify(ev), NO_SIG, nd);
  assertEquals(r.status, 200);
  assertEquals(r.body, {});
  assertEquals(sends, 0);
  assertEquals(traces.some((t) => t.action === "native_hook"), true);
});
