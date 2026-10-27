import { assert, assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { sha256Hex } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";
import { fakeAi } from "./fakes.ts";
import type { ConversationRow, MessageRow, ProfileRow, Workspace } from "../_shared/types.ts";

const WS: Workspace = {
  website_id: "ws1",
  name: "App A",
  topics: [{ key: "billing", label: "Billing", segments: ["billing"] }],
  default_profile: {},
  jira_project: null,
  storefront_watch: false,
  review_link: null,
};
const CONV: ConversationRow = {
  website_id: "ws1",
  session_id: "session_1",
  customer_email: "k@x.io",
  customer_name: "Khách",
  topic: "billing",
  topic_source: "segment",
  state: "unresolved",
  last_customer_at: "2026-10-15T03:03:00+00:00",
  last_human_operator_at: "2026-10-15T03:02:00+00:00",
  updated_at: "2026-10-15T03:03:00+00:00",
  custom_data: {},
};
const MSGS: MessageRow[] = [
  { id: 1, content_en: null, from: "user", type: "text", is_bot: false, content: "a", created_at: "2026-10-15T03:01:00+00:00", operator_name: null },
  { id: 2, content_en: null, from: "operator", type: "text", is_bot: false, content: "b", created_at: "2026-10-15T03:02:00+00:00", operator_name: "Lan" },
  { id: 3, content_en: null, from: "user", type: "text", is_bot: false, content: "c", created_at: "2026-10-15T03:03:00+00:00", operator_name: null },
];
const PROFILES: ProfileRow[] = [
  { crisp_user_id: "op-lan", website_id: "ws1", topic: "billing", tone: "chi tiết", conversations_used: 9, learned_at: null, manual_override: null },
];

const TOKEN = "tok-lan";
const TOKEN_HASH = await sha256Hex(TOKEN);
const CRISP_TOKEN = "11111111-2222-3333-4444-555555555555";
const WIDGET_HASH = await sha256Hex(CRISP_TOKEN);

function deps(over: Partial<Db> = {}, stale = false) {
  const db: Db = {
    getWorkspace: () => Promise.resolve(WS),
    logTrace: () => Promise.resolve(),
    getWidgetTokenHash: () => Promise.resolve(WIDGET_HASH),
    getOperatorIdByTokenHash: (h) => Promise.resolve(h === TOKEN_HASH ? "op-lan" : null),
    isOperatorMember: () => Promise.resolve(true),
    getConversation: () => Promise.resolve(CONV),
    getMessages: () => Promise.resolve(MSGS),
    saveTranslations: () => Promise.resolve(),
    getProfiles: () => Promise.resolve(PROFILES),
    getWorkspaceAllProfiles: () => Promise.resolve(PROFILES),
    getOperator: () => Promise.resolve({ display_name: "Lan Nguyen" }),
    findCachedOutput: () => Promise.resolve(null),
    insertOutput: () => Promise.resolve(1),
    saveReviewTemplate: () => Promise.resolve(),
    addStyleSample: () => Promise.resolve(),
    getLatestDraft: () => Promise.resolve(null),
    setAiTopic: () => Promise.resolve(),
    matchHelpdesk: () => Promise.resolve([]),
    hybridMatchHelpdesk: () => Promise.resolve([]),
    matchCases: () => Promise.resolve([]),
    getVariants: () => Promise.resolve([]),
    getJiraRows: () => Promise.resolve([]),
    unlinkJira: () => Promise.resolve(false),
    mergeConversationCustomData: () => Promise.resolve(true),
    getSentiment: () => Promise.resolve(null),
    saveSentiment: () => Promise.resolve(),
    getStorefrontSeen: () => Promise.resolve([]),
    markStorefrontSeen: () => Promise.resolve(),
    getStorefrontStoreStatus: () => Promise.resolve(null),
    upsertStorefrontStoreStatus: () => Promise.resolve(),
    getRecentShopDomains: () => Promise.resolve([]),
    listStorefrontStoreStatus: () => Promise.resolve([]),
    getStorefrontSegmentCandidates: () => Promise.resolve([]),
    getCsatSend: () => Promise.resolve(null),
    recordCsatSend: () => Promise.resolve({ sent_at: "2026-10-15T03:05:00+00:00" }),
    releaseCsatSend: () => Promise.resolve(),
    ...over,
  };
  const n8n: N8n = {
    refreshConversation: () => Promise.resolve({ stale }),
    sendSurvey: () => Promise.resolve(true),
    triggerJiraSync: () => Promise.resolve(true),
  };
  return { db, n8n, ai: fakeAi({}).ai };
}

const REQ = { website_id: "ws1", session_id: "session_1", action: "check" };

Deno.test("check returns unanswered, topic and profile", async () => {
  const r = await handle(REQ, TOKEN, deps());
  assertEquals(r.status, 200);
  assertEquals(r.body, {
    action: "check",
    stale: false,
    workspace: "App A",
    customer_name: "Khách",
    customer_email: "k@x.io",
    shopify_domain: null,
    topic: "billing",
    topic_label: "Billing",
    profile_source: "topic",
    profile_name: "Lan Nguyen",
    profile_coverage: { conversations_used: 9, learned_at: null }, // từ dòng profile fake của CS này
    review_template: {
      source: "default",
      suggestion: null,
      text: "Hi there,\n\nThank you for reaching out to us. I hope your issue has been resolved. If you're happy with our app and the support you received, we'd be grateful if you could spend a few seconds leaving a review on the Shopify App Store. Your feedback means a lot to us and helps us keep improving.\n\nThank you so much!",
    },
    conversation_state: "unresolved",
    needs_reply: true,
    unanswered: ["c"],
    pending_messages: [{ text: "c", bot_replied: false }],
    bot_replied_count: 0,
    last_customer_at: CONV.last_customer_at,
    last_human_operator_at: CONV.last_human_operator_at,
    jira: [],
    modules: { jira: false, storefront: false },
    storefront_status: null,
    sentiment: null,
    sentiment_stale: true, // chưa từng phân tích mà đã có tin khách → panel tự làm tươi khi mở
    jira_stale: false, // không có ticket Jira nào được liên kết
    csat: { sent: false, sent_at: null },
    latest_draft: null,
  });
});

const JIRA_ROW = (key: string) => ({
  link: {
    website_id: "ws1", session_id: "session_1", issue_key: key,
    url: `https://firegroup.atlassian.net/browse/${key}`,
    silent_baseline: false, last_seen_status: null, last_seen_comment_at: null,
  },
  issue: null,
});
const modulesOf = (r: { body: unknown }) => (r.body as { modules: { jira: boolean; storefront: boolean } }).modules;

Deno.test("check modules: ticket thuộc project của workspace → bật Jira + Storefront", async () => {
  const r = await handle(REQ, TOKEN, deps({
    getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT" }),
    getJiraRows: () => Promise.resolve([JIRA_ROW("TNT-9184")]),
  }));
  assertEquals(r.status, 200);
  assertEquals(modulesOf(r), { jira: true, storefront: true });
});

Deno.test("check modules: ticket project khác → chỉ Jira, không Storefront", async () => {
  const r = await handle(REQ, TOKEN, deps({
    getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT" }),
    getJiraRows: () => Promise.resolve([JIRA_ROW("OES-15")]),
  }));
  assertEquals(modulesOf(r), { jira: true, storefront: false });
});

Deno.test("check modules: workspace chưa set jira_project → Storefront tắt dù có ticket", async () => {
  const r = await handle(REQ, TOKEN, deps({
    getJiraRows: () => Promise.resolve([JIRA_ROW("TNT-9184")]),
  }));
  assertEquals(modulesOf(r), { jira: true, storefront: false });
});

const SF_STATUS = (over: Record<string, unknown> = {}) => ({
  website_id: "ws1", shop: "shop-a.myshopify.com", watched: true,
  open_critical: 1, open_high: 2, open_medium: 0, open_low: 0, open_total: 3,
  worst_severity: "critical", last_good_check: "2026-10-22", fetched_at: "2026-10-23T00:00:00.000Z",
  ...over,
});
const CONV_WITH_SHOP = { ...CONV, custom_data: { shopify_domain: "shop-a.myshopify.com" } };
const sfStatusOf = (r: { body: unknown }) => (r.body as { storefront_status: unknown }).storefront_status;

Deno.test("check modules: Transcy (cờ storefront_watch bật) + chat có shopify_domain, CHƯA có bản chụp → Storefront bật theo domain, không cần ticket; storefront_status = null", async () => {
  const r = await handle(REQ, TOKEN, deps({
    getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT", storefront_watch: true }),
    getConversation: () => Promise.resolve(CONV_WITH_SHOP),
  }));
  assertEquals(modulesOf(r), { jira: true, storefront: true });
  assertEquals(sfStatusOf(r), null);
});

Deno.test("check modules: bản chụp nói SW đang theo dõi + có lỗi mở → Storefront bật và storefront_status đi kèm để widget hiện badge", async () => {
  const r = await handle(REQ, TOKEN, deps({
    getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT", storefront_watch: true }),
    getConversation: () => Promise.resolve(CONV_WITH_SHOP),
    getStorefrontStoreStatus: () => Promise.resolve(SF_STATUS()),
  }));
  assertEquals(modulesOf(r), { jira: true, storefront: true });
  assertEquals(sfStatusOf(r), SF_STATUS());
});

Deno.test("check modules: bản chụp nói SW KHÔNG theo dõi domain → Storefront VẪN bật (bản chụp không còn quyền phủ quyết, Ethan chốt 2026-10-26)", async () => {
  const r = await handle(REQ, TOKEN, deps({
    getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT", storefront_watch: true }),
    getConversation: () => Promise.resolve(CONV_WITH_SHOP),
    getStorefrontStoreStatus: () => Promise.resolve(SF_STATUS({ watched: false, open_critical: 0, open_high: 0, open_total: 0, worst_severity: null })),
  }));
  assertEquals(modulesOf(r), { jira: true, storefront: true });
});

Deno.test("check modules: workspace OE (jira_project = OES, cờ storefront_watch TẮT) + chat có shopify_domain + có bản chụp watched → Storefront vẫn tắt và badge KHÔNG rò (storefront_status = null)", async () => {
  // Khoá hồi quy lỗi định danh cũ: OE cũng có jira_project (OES) — trước đây
  // điều đó đủ để mở cổng domain và lộ badge cho OE. Nay phạm vi SW chỉ do
  // cờ storefront_watch quyết; cờ tắt thì check không trả bản chụp nào cả.
  const r = await handle(REQ, TOKEN, deps({
    getWorkspace: () => Promise.resolve({ ...WS, jira_project: "OES" }),
    getConversation: () => Promise.resolve(CONV_WITH_SHOP),
    getStorefrontStoreStatus: () => Promise.resolve(SF_STATUS()),
  }));
  assertEquals(modulesOf(r), { jira: true, storefront: false });
  assertEquals(sfStatusOf(r), null);
});

Deno.test("check modules: đọc bản chụp lỗi → coi như chưa có bản chụp, check vẫn chạy và cổng domain vẫn mở", async () => {
  const r = await handle(REQ, TOKEN, deps({
    getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT", storefront_watch: true }),
    getConversation: () => Promise.resolve(CONV_WITH_SHOP),
    getStorefrontStoreStatus: () => Promise.reject(new Error("db down")),
  }));
  assertEquals(r.status, 200);
  assertEquals(modulesOf(r), { jira: true, storefront: true });
  assertEquals(sfStatusOf(r), null);
});

Deno.test("check passes through stale flag", async () => {
  const r = await handle(REQ, TOKEN, deps({}, true));
  assertEquals((r.body as { stale: boolean }).stale, true);
});

Deno.test("unknown action -> 400", async () => {
  assertEquals((await handle({ ...REQ, action: "delete" }, TOKEN, deps())).status, 400);
});

Deno.test("missing session_id -> 400", async () => {
  assertEquals((await handle({ ...REQ, session_id: "" }, TOKEN, deps())).status, 400);
});

Deno.test("non-object body -> 400", async () => {
  assertEquals((await handle("nope", TOKEN, deps())).status, 400);
});

Deno.test("conversation not in DB -> 404", async () => {
  assertEquals((await handle(REQ, TOKEN, deps({ getConversation: () => Promise.resolve(null) }))).status, 404);
});

Deno.test("bad token -> 401", async () => {
  assertEquals((await handle(REQ, "wrong!", deps())).status, 401);
});

Deno.test("unexpected error -> 500 without leaking details", async () => {
  const r = await handle(REQ, TOKEN, deps({ getMessages: () => Promise.reject(new Error("db password=xyz")) }));
  assertEquals(r.status, 500);
  assertEquals(r.body, { error: "Lỗi hệ thống, thử lại sau" });
});

Deno.test("malformed session_id is rejected before reaching n8n", async () => {
  let refreshed = false;
  const d = deps();
  d.n8n.refreshConversation = () => {
    refreshed = true;
    return Promise.resolve({ stale: false });
  };
  const r = await handle({ ...REQ, session_id: "session_1/../../operators" }, TOKEN, d);
  assertEquals(r.status, 400);
  assertEquals(refreshed, false);
});

Deno.test("malformed website_id -> 400", async () => {
  assertEquals((await handle({ ...REQ, website_id: "ws1?x=1" }, TOKEN, deps())).status, 400);
});

Deno.test("widget request (no personal token) authenticates with Crisp token + operator_id", async () => {
  const r = await handle({ ...REQ, crisp_token: CRISP_TOKEN, operator_id: "op-lan" }, "", deps());
  assertEquals(r.status, 200);
  assertEquals((r.body as { profile_name: string }).profile_name, "Lan Nguyen");
});

Deno.test("widget request with forged Crisp token -> 401", async () => {
  assertEquals((await handle({ ...REQ, crisp_token: "forged", operator_id: "op-lan" }, "", deps())).status, 401);
});

const RAW_JIRA_ISSUE = {
  key: "TNT-9184",
  fields: {
    summary: "Switcher missing",
    status: { name: "Pending Dev", statusCategory: { key: "indeterminate" } },
    assignee: null,
    updated: "2026-10-15T03:10:00.000Z",
    comment: { comments: [] },
  },
};

function fakeJiraStore(saved: unknown[], onSave?: () => void) {
  return {
    csNames: () => Promise.resolve([] as string[]),
    saveIssue: (i: unknown) => {
      saved.push(i);
      onSave?.();
      return Promise.resolve({ status_changed_at: null, prev_status: null });
    },
    linksFor: () => Promise.resolve([]),
    updateLink: () => Promise.resolve(),
    lastHumanOperatorAt: () => Promise.resolve(null),
  };
}

Deno.test("jira_sync_now: chưa cấu hình Jira API -> triggered false kèm lý do cấu hình", async () => {
  const r = await handle({ ...REQ, action: "jira_sync_now" }, TOKEN, deps());
  assertEquals(r.status, 200);
  const body = r.body as { triggered: boolean; error: string | null };
  assertEquals(body.triggered, false);
  assert(typeof body.error === "string" && body.error.includes("JIRA_EMAIL"));
});

Deno.test("jira_sync_now: gọi thẳng Jira REST và áp vào mirror -> triggered true", async () => {
  const saved: unknown[] = [];
  const d = {
    ...deps({ getJiraRows: () => Promise.resolve([JIRA_ROW("TNT-9184")]) }),
    jira: {
      searchIssues: (keys: string[]) => {
        assertEquals(keys, ["TNT-9184"]);
        return Promise.resolve([RAW_JIRA_ISSUE]);
      },
    },
    jiraStore: fakeJiraStore(saved),
  };
  const r = await handle({ ...REQ, action: "jira_sync_now" }, TOKEN, d);
  assertEquals(r.status, 200);
  assertEquals(r.body, { action: "jira_sync_now", triggered: true, error: null });
  assertEquals(saved.length, 1);
});

Deno.test("jira_sync_now: Jira lỗi -> triggered false kèm lý do, không nuốt lỗi", async () => {
  const d = {
    ...deps({ getJiraRows: () => Promise.resolve([JIRA_ROW("TNT-9184")]) }),
    jira: { searchIssues: () => Promise.reject(new Error("Jira search lỗi (HTTP 500)")) },
    jiraStore: fakeJiraStore([]),
  };
  const r = await handle({ ...REQ, action: "jira_sync_now" }, TOKEN, d);
  assertEquals(r.status, 200);
  const body = r.body as { triggered: boolean; error: string | null };
  assertEquals(body.triggered, false);
  assert(typeof body.error === "string" && body.error.includes("HTTP 500"));
});

Deno.test("check: mirror Jira đã cũ -> trả NGAY bản cũ + jira_stale, sync chạy nền không chặn check", async () => {
  let synced = false;
  const row = (summary: string, syncedAt: string) => ({
    link: {
      website_id: "ws1", session_id: "session_1", issue_key: "TNT-9184",
      url: "https://firegroup.atlassian.net/browse/TNT-9184",
      silent_baseline: false, last_seen_status: "Pending Dev", last_seen_comment_at: null,
    },
    issue: {
      issue_key: "TNT-9184", summary, status: "Pending Dev", status_category: "indeterminate", assignee: null,
      updated_at: null, status_changed_at: null, synced_at: syncedAt, comments: [],
    },
  });
  const saved: unknown[] = [];
  const d = {
    ...deps({ getJiraRows: () => Promise.resolve([row(synced ? "Bản mới từ Jira" : "Bản cũ", "2026-10-15T02:00:00+00:00")]) }),
    jira: { searchIssues: () => Promise.resolve([RAW_JIRA_ISSUE]) },
    jiraStore: fakeJiraStore(saved, () => { synced = true; }),
  };
  const r = await handle(REQ, TOKEN, d);
  assertEquals(r.status, 200);
  const body = r.body as { jira: { summary: string }[]; jira_stale: boolean };
  // Check KHÔNG chờ Jira nữa: trả mirror cũ ngay, gắn cờ để widget nạp lại.
  assertEquals(body.jira[0].summary, "Bản cũ");
  assertEquals(body.jira_stale, true);
  // Việc sync vẫn xảy ra — ở nền, sau khi response đã trả.
  await new Promise((res) => setTimeout(res, 10));
  assertEquals(saved.length, 1);
});

Deno.test("check: mirror Jira còn tươi -> không gọi Jira lại", async () => {
  let calls = 0;
  const row = {
    link: {
      website_id: "ws1", session_id: "session_1", issue_key: "TNT-9184",
      url: "https://firegroup.atlassian.net/browse/TNT-9184",
      silent_baseline: false, last_seen_status: "Pending Dev", last_seen_comment_at: null,
    },
    issue: {
      issue_key: "TNT-9184", summary: "Đang tươi", status: "Pending Dev", status_category: "indeterminate", assignee: null,
      updated_at: null, status_changed_at: null, synced_at: new Date().toISOString(), comments: [],
    },
  };
  const d = {
    ...deps({ getJiraRows: () => Promise.resolve([row]) }),
    jira: { searchIssues: () => { calls++; return Promise.resolve([]); } },
    jiraStore: fakeJiraStore([]),
  };
  const r = await handle(REQ, TOKEN, d);
  assertEquals(r.status, 200);
  assertEquals(calls, 0);
});

Deno.test("jira_unlink: gỡ đúng (website, session, key) gửi lên và báo removed", async () => {
  const calls: string[][] = [];
  const d = deps({
    unlinkJira: (w, s, k) => {
      calls.push([w, s, k]);
      return Promise.resolve(true);
    },
  });
  const r = await handle({ ...REQ, action: "jira_unlink", issue_key: "TNT-9192" }, TOKEN, d);
  assertEquals(r.status, 200);
  assertEquals(r.body, { action: "jira_unlink", issue_key: "TNT-9192", removed: true });
  assertEquals(calls, [["ws1", "session_1", "TNT-9192"]]);
});

Deno.test("jira_unlink: chat không theo dõi ticket đó -> removed false, vẫn 200", async () => {
  const r = await handle({ ...REQ, action: "jira_unlink", issue_key: "OES-15" }, TOKEN, deps());
  assertEquals(r.status, 200);
  assertEquals(r.body, { action: "jira_unlink", issue_key: "OES-15", removed: false });
});

Deno.test("jira_unlink: issue_key sai định dạng -> 400, không gọi db", async () => {
  let called = false;
  const d = deps({
    unlinkJira: () => {
      called = true;
      return Promise.resolve(true);
    },
  });
  for (const bad of ["bad key", "tnt-9192", "TNT9192", "TNT-", "TNT-1 OR 1=1", ""]) {
    assertEquals((await handle({ ...REQ, action: "jira_unlink", issue_key: bad }, TOKEN, d)).status, 400, bad);
  }
  assertEquals(called, false);
});

Deno.test("tracing: mỗi request ghi 1 dòng timing theo action; request lỗi ghi thêm dòng error có message", async () => {
  const rows: { kind: string; action?: string | null; stage?: string | null; message?: string | null }[] = [];
  const cap = {
    logTrace: (row: never) => {
      rows.push(row);
      return Promise.resolve();
    },
  };
  const ok = await handle(REQ, TOKEN, deps(cap as Partial<Db>));
  assertEquals(ok.status, 200);
  assertEquals(rows.filter((r) => r.kind === "timing" && r.action === "check" && r.stage === "handler").length, 1);
  const bad = await handle({ ...REQ, action: "khong_co_action_nay" }, TOKEN, deps(cap as Partial<Db>));
  assertEquals(bad.status, 400);
  assertEquals(rows.some((r) => r.kind === "error" && typeof r.message === "string" && r.message.length > 0), true);
});
