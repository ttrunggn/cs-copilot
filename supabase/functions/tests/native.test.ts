import { assertEquals } from "jsr:@std/assert@1";
import { sentimentFingerprint } from "../copilot/analyze.ts";
import {
  computeCrispWidgetSignature,
  diagnoseCrispWidgetSignature,
  formatMoodValue,
  handleNativeEvent,
  hhmmSaigon,
  isNativeEvent,
  MOOD_BUTTON_IDS,
  type NativeDeps,
  scanAgeText,
} from "../copilot/native.ts";
import type { CrispClient } from "../_shared/crisp.ts";
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
    pluginKeys: [pluginKey],
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
      worst_severity: null, last_good_check: null,
      fetched_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    }),
  });
  const r1 = await fetchValue("tt_storefront", { db: { ...base, ...snap(true, 3) } });
  assertEquals(r1.body, { data: { value: "3 lỗi · quét 2 giờ trước" } });
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

Deno.test("native: chữ ký theo công thức DOC Crisp [timestamp;body] (tính độc lập, không qua helper) → qua; công thức chấm cũ → 401", async () => {
  // Công thức lấy nguyên văn từ Web Hooks Reference của Crisp: ghép chuỗi
  // `[timestamp;body_as_string]` rồi HMAC-SHA256 bằng secret. Test này tính
  // chữ ký THẲNG bằng crypto.subtle, không dùng computeCrispWidgetSignature,
  // để helper có lệch công thức là test đỏ ngay (bản cũ `${ts}.${body}` từng
  // xanh giả vì test ký bằng chính helper).
  const body = fetchEvent("khach_tin_cho");
  const raw = JSON.stringify(body);
  const ts = "1761732000";
  const enc = new TextEncoder();
  const signWith = async (signed: string) => {
    const key = await crypto.subtle.importKey("raw", enc.encode(KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signed));
    return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
  };

  const docSig = await signWith(`[${ts};${raw}]`);
  const ok = nativeDeps({}, KEY);
  const r1 = await handleNativeEvent(body, raw, { signature: docSig, timestamp: ts }, ok.nd);
  assertEquals(r1.status, 200);

  const oldSig = await signWith(`${ts}.${raw}`);
  const bad = nativeDeps({}, KEY);
  const r2 = await handleNativeEvent(body, raw, { signature: oldSig, timestamp: ts }, bad.nd);
  assertEquals(r2.status, 401);
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
  const nd: NativeDeps = { db: deps.db, ai: deps.ai, n8n: deps.n8n, pluginKeys: [] };
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
  const nd: NativeDeps = { db: deps.db, ai: deps.ai, n8n: deps.n8n, pluginKeys: [] };
  const ev = hookEvent("act_csat", { operator_email: "ngoai@x.io" });
  const r = await handleNativeEvent(ev, JSON.stringify(ev), NO_SIG, nd);
  assertEquals(r.status, 200);
  assertEquals(sends, 0);
});

Deno.test("native: sự kiện nút không phải hook CSAT → 200 {} và không gửi gì", async () => {
  let sends = 0;
  const { deps, traces } = makeDeps();
  deps.n8n.sendSurvey = () => (sends++, Promise.resolve(true));
  const nd: NativeDeps = { db: deps.db, ai: deps.ai, n8n: deps.n8n, pluginKeys: [] };
  const ev = hookEvent("act_draft");
  const r = await handleNativeEvent(ev, JSON.stringify(ev), NO_SIG, nd);
  assertEquals(r.status, 200);
  assertEquals(r.body, {});
  assertEquals(sends, 0);
  assertEquals(traces.some((t) => t.action === "native_hook"), true);
});

// ---------- Bản 6 section theo design 30/10 ----------

Deno.test("native fetch: trạng thái bot là bản giả (stub) cố định", async () => {
  const r = await fetchValue("bot_trang_thai");
  assertEquals(r.body, { data: { value: "CS đang xử lý · Chatbot im lặng" } });
});

Deno.test("native fetch: điểm cảm xúc dạng số (cho condition đọc qua custom data); chưa có → '—'", async () => {
  const r1 = await fetchValue("khach_diem", { db: { getSentiment: () => Promise.resolve(SENTIMENT) } });
  assertEquals(r1.body, { data: { value: "38" } });
  const r2 = await fetchValue("khach_diem");
  assertEquals(r2.body, { data: { value: "—" } });
});

Deno.test("native fetch: slot Jira hiện '{KEY} · {Status} (new update)'; thiếu ticket → rỗng", async () => {
  const link = {
    website_id: "ws1", session_id: "session_1", issue_key: "TNT-2481",
    url: "https://firegroup.atlassian.net/browse/TNT-2481", silent_baseline: false,
    last_seen_status: null, last_seen_comment_at: null,
  };
  const issue = {
    issue_key: "TNT-2481", summary: "Lỗi dịch trang product", status: "In Progress",
    status_category: "indeterminate", assignee: null, updated_at: "2026-10-30T05:00:00.000Z",
    status_changed_at: "2026-10-20T00:00:00.000Z", prev_status: "To Do", comments: [],
  };
  const over = { db: { getJiraRows: () => Promise.resolve([{ link, issue }]) } };
  const r1 = await fetchValue("jira_ticket_1", over);
  assertEquals(r1.body, { data: { value: "TNT-2481 · In Progress (new update)" } });
  const r2 = await fetchValue("jira_ticket_2", over);
  assertEquals(r2.body, { data: { value: "" } });
  const r3 = await fetchValue("jira_ticket_3");
  assertEquals(r3.body, { data: { value: "" } });
});

Deno.test("native fetch: Storefront kèm tuổi đợt quét từ bản chụp (now cố định)", async () => {
  const { deps } = makeDeps({
    db: {
      getWorkspace: () => Promise.resolve({ website_id: "ws1", name: "App A", topics: [], default_profile: {}, jira_project: null, storefront_watch: true, review_link: null }),
      getConversation: () => Promise.resolve({ ...CONV, custom_data: { shopify_domain: "shop.myshopify.com" } }),
      getStorefrontStoreStatus: () => Promise.resolve({
        website_id: "ws1", shop: "shop.myshopify.com", watched: true,
        open_critical: 1, open_high: 0, open_medium: 0, open_low: 0, open_total: 3,
        worst_severity: "critical", last_good_check: null,
        fetched_at: "2026-10-30T00:00:00.000Z",
      }),
    },
  });
  const body = fetchEvent("tt_storefront");
  const r = await handleNativeEvent(body, JSON.stringify(body), NO_SIG, {
    db: deps.db, ai: deps.ai, n8n: deps.n8n,
    now: () => new Date("2026-10-30T07:00:00.000Z").getTime(),
  });
  assertEquals(r.body, { data: { value: "3 lỗi · quét 7 giờ trước" } });
  assertEquals(scanAgeText("2026-10-30T06:35:00.000Z", new Date("2026-10-30T07:00:00.000Z").getTime()), "25 phút");
  assertEquals(scanAgeText("2026-10-28T07:00:00.000Z", new Date("2026-10-30T07:00:00.000Z").getTime()), "2 ngày");
  assertEquals(scanAgeText("không-phải-ngày", 0), "");
});

Deno.test("native hook: nút Tâm trạng → phân tích lại (force) + đồng bộ dải cam lên custom data Crisp", async () => {
  const { ai, calls } = fakeAi({
    sentiment: JSON.stringify({ score: 30, mood: "frustrated", urgency: "high", confidence: 0.9, summary: "Khách đang bực vì lỗi dịch", signals: [], issues: [] }),
  });
  const customDataWrites: Record<string, unknown>[] = [];
  const crisp: CrispClient = {
    getConversationSegments: () => Promise.resolve([]),
    setConversationSegments: () => Promise.resolve(),
    getConversationCustomData: () => Promise.resolve({ shopify_domain: "shop1.myshopify.com" }),
    setConversationCustomData: (_w, _s, data) => {
      customDataWrites.push(data);
      return Promise.resolve();
    },
  };
  const { deps, traces } = makeDeps({ ai });
  const nd: NativeDeps = { db: deps.db, ai: deps.ai, n8n: deps.n8n, crisp, pluginKeys: [] };
  const body = hookEvent("tam_orange");
  const r = await handleNativeEvent(body, JSON.stringify(body), NO_SIG, nd);
  assertEquals(r.status, 200);
  assertEquals(calls.some((c) => c.task === "sentiment"), true);
  // Điểm 30 → dải orange; object ghi lên Crisp giữ nguyên key shopify_domain.
  assertEquals(customDataWrites, [{ shopify_domain: "shop1.myshopify.com", copilot_mood_band: "orange" }]);
  assertEquals(traces.some((t) => t.stage === "mood_recompute" && t.detail?.ok === true && t.detail?.score === 30), true);
});

Deno.test("native hook: nút Chatbot là stub — 200, trace gắn cờ stub, không gọi AI", async () => {
  const { nd, traces, deps } = nativeDeps();
  void deps;
  const body = hookEvent("bot_chan");
  const r = await handleNativeEvent(body, JSON.stringify(body), NO_SIG, nd);
  assertEquals(r.status, 200);
  assertEquals(r.body, {});
  assertEquals(traces.some((t) => t.stage === "button" && t.detail?.stub === true && t.detail?.item_id === "bot_chan"), true);
});

Deno.test("native: chữ ký bằng khoá THỨ HAI (plugin survey) vẫn qua; khoá lạ → 401", async () => {
  const body = fetchEvent("khach_tin_cho");
  const raw = JSON.stringify(body);
  const ts = "1761732000";
  const sigSurvey = await computeCrispWidgetSignature("survey-key-xyz", ts, raw);
  const { nd } = nativeDeps({}, "");
  nd.pluginKeys = ["plugin-key-chinh", "survey-key-xyz"];
  const r1 = await handleNativeEvent(body, raw, { signature: sigSurvey, timestamp: ts }, nd);
  assertEquals(r1.status, 200);
  const sigLa = await computeCrispWidgetSignature("key-khong-co-that", ts, raw);
  const r2 = await handleNativeEvent(body, raw, { signature: sigLa, timestamp: ts }, nd);
  assertEquals(r2.status, 401);
});

Deno.test("native: schema native-panel.json khớp handler — data item nào cũng fetch được, hook nào cũng thuộc nhóm đã biết", async () => {
  const text = await Deno.readTextFile(new URL("../../../widget/native-panel.json", import.meta.url));
  const schema = JSON.parse(text) as { sections: { id: string; items: { id: string; type: string; value?: { type?: string } }[] }[] };
  assertEquals(schema.sections.map((s) => s.id), ["chatbot", "khach", "trang_thai", "storefront", "jira", "lenh"]);
  for (const section of schema.sections) {
    for (const item of section.items) {
      if (item.type === "data") {
        const r = await fetchValue(item.id);
        assertEquals(r.status, 200, `data item ${item.id}`);
        const v = (r.body as { data: { value: unknown } }).data.value;
        assertEquals(typeof v, "string", `data item ${item.id} phải trả chuỗi`);
      }
      if (item.type === "button" && item.value?.type === "hook") {
        const known = item.id === "act_csat" || MOOD_BUTTON_IDS.has(item.id) || item.id === "bot_tra_loi" || item.id === "bot_chan";
        assertEquals(known, true, `hook ${item.id} phải có handler`);
      }
    }
  }
});

Deno.test("diagnoseCrispWidgetSignature: nhận ra các biến thể ghép chuỗi ký", async () => {
  const secret = "diag-secret-0123456789";
  const ts = "1761733000123";
  const body = '{"action":{"type":"data","method":"fetch"}}';
  const enc = new TextEncoder();
  const sign = async (payload: string) => {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
    return [...sig].map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  // Công thức theo tài liệu — biến thể [ms;raw], khoá nguyên văn
  assertEquals(await diagnoseCrispWidgetSignature(secret, ts, body, await sign(`[${ts};${body}]`)), ["lit:[ms;raw]:hex"]);
  // Không ngoặc vuông
  assertEquals(await diagnoseCrispWidgetSignature(secret, ts, body, await sign(`${ts};${body}`)), ["lit:ms;raw:hex"]);
  // Timestamp theo giây trong khi header là mili-giây
  assertEquals(await diagnoseCrispWidgetSignature(secret, ts, body, await sign(`[${ts.slice(0, 10)};${body}]`)), ["lit:[sec;raw]:hex"]);
  // Chỉ ký body
  assertEquals(await diagnoseCrispWidgetSignature(secret, ts, body, await sign(body)), ["lit:raw-only:hex"]);
  // Khoá hiệu dụng là bytes giải mã từ chuỗi hex (khoá Crisp dạng hex)
  const hexSecret = "0123456789abcdef".repeat(4);
  const hexBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) hexBytes[i] = parseInt(hexSecret.slice(i * 2, i * 2 + 2), 16);
  const key2 = await crypto.subtle.importKey("raw", hexBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig2 = new Uint8Array(await crypto.subtle.sign("HMAC", key2, enc.encode(`[${ts};${body}]`)));
  const sig2Hex = [...sig2].map((x) => x.toString(16).padStart(2, "0")).join("");
  assertEquals(await diagnoseCrispWidgetSignature(hexSecret, ts, body, sig2Hex), ["hex:[ms;raw]:hex"]);
  // Chữ ký rác → không biến thể nào
  assertEquals(await diagnoseCrispWidgetSignature(secret, ts, body, "0".repeat(64)), []);
  // Khoá khác → không biến thể nào
  assertEquals(await diagnoseCrispWidgetSignature("another-secret-987654321", ts, body, await sign(`[${ts};${body}]`)), []);
});
