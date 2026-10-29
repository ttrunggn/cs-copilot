import { assertEquals } from "jsr:@std/assert@1";
import { toDraftViewModel, toViewModel } from "./core.js";
import { state } from "./state.js";

// Fake DOM tối thiểu viết tay (không jsdom): đủ cho dom.js/panels.js chạy —
// createElement/createTextNode/getElementById + cây children để duyệt tìm
// nút và bấm thử. panels.js + dom.js phải import SAU khi stub document,
// nên dùng dynamic import ở dưới.
class FakeText {
  constructor(text) { this.textContent = text; this.children = []; }
}
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.attrs = {};
    this.parentElement = null;
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      const node = typeof n === "string" ? new FakeText(n) : n;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
}
globalThis.document = {
  getElementById: () => null,
  createElement: (tag) => new FakeEl(tag),
  createTextNode: (t) => new FakeText(String(t)),
};
const { commandsRow, csatPanel, draftCompose, draftPanel, extensionHint, handoffPanel, insightPanel, issuesPanel, jiraPanel, knowledgePanel, modalView, storefrontPanel } = await import("./panels.js");

// ---------- helpers ----------
function walk(node, out = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  for (const c of node.children ?? []) walk(c, out);
  return out;
}
function allText(root) {
  return walk(root).map((n) => (typeof n.textContent === "string" ? n.textContent : "")).join(" ").replace(/\s+/g, " ");
}
function buttons(root) { return walk(root).filter((n) => n.tagName === "BUTTON"); }
function buttonByText(root, needle) { return buttons(root).find((b) => allText(b).includes(needle) || b.textContent === needle); }
function marker() {
  const d = document.createElement("div");
  d.className = "insert-choice-marker";
  return d;
}
function reset() {
  Object.assign(state, {
    check: null, draft: null, handoff: null, sentiment: null, sentimentMsgCount: 0,
    csat: null, csatError: false, csatErrorMsg: "", modal: null, busy: "", busyAction: "",
    progress: null, choice: false, choiceFor: "draft", insertPending: false, bridge: "ready", bridgeVersion: "",
    bridgeResponders: [], bridgeConflict: false, lastInsertTrace: "",
    draftPlacement: "", notePlacement: "", unlinkConfirm: "", storefront: null,
    storefrontShopInput: "", storefrontShop: "", storefrontDetail: null, storefrontDetailLoading: "",
    askQuestion: "", askResult: null, hint: "", tone: "default", csatChoice: "",
    reviewText: "", reviewInsertId: "", composeOpen: true, notice: "", noticeKind: "",
    explainText: "", explainFinding: null, explainInsertId: "",
    sfMenu: "", sfForm: null, sfNoteInput: "", sfReason: "", sfClosed: {}, sfActBusy: "", sfMsg: "", sfTab: "",
    operatorName: "",
  });
}
function makeHandlers(calls = []) {
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  return {
    onGenerate: rec("generate"), onHandoff: rec("handoff"), onAnalyze: rec("analyze"),
    onSurvey: rec("survey"), onAsk: rec("ask"), onAskCompose: rec("askCompose"), onAskRetry: rec("askRetry"),
    onEditInCrisp: rec("edit"), onInsertNote: rec("insertNote"), onJiraSync: rec("jiraSync"),
    onJiraUnlink: rec("jiraUnlink"), onStorefrontLoad: rec("sfLoad"), onStorefrontFinding: rec("sfFinding"),
    onStorefrontMenu: rec("sfMenu"), onStorefrontForm: rec("sfForm"), onStorefrontAct: rec("sfAct"),
    onExplain: rec("explain"), sendExplainInsert: rec("explainInsert"),
    sendReviewInsert: rec("reviewInsert"), detectExtension: rec("detect"),
    onOpenModal: rec("openModal"), onCloseModal: rec("closeModal"),
    progressCard: () => null, insertChoice: () => marker(), rerender: rec("rerender"),
  };
}
const CHECK = {
  stale: false, topic: "billing", topic_label: "Billing", profile_source: "topic", profile_name: "Lan",
  needs_reply: true, unanswered: ["tin 1"], last_customer_at: null, last_human_operator_at: null, jira: [],
};

Deno.test("panels: form Draft — lựa chọn giọng mặc định ghi rõ 'Mặc định (theo profile CS)'", () => {
  reset();
  const t = allText(draftCompose(makeHandlers()));
  assertEquals(t.includes("Mặc định (theo profile CS)"), true);
});

// ---------- hàng lệnh + popup mở/đóng ----------
Deno.test("panels: hàng lệnh có đúng 4 nút và bấm từng nút mở đúng popup", () => {
  reset();
  const calls = [];
  const row = commandsRow(makeHandlers(calls));
  const bs = buttons(row);
  assertEquals(bs.length, 4);
  assertEquals(bs.map((b) => allText(b).trim()), ["Draft", "Private note", "Knowledge Base Asking", "Xin CSAT / Review"]);
  for (const b of bs) b.onclick();
  assertEquals(calls, [["openModal", "draft"], ["openModal", "note"], ["openModal", "ask"], ["openModal", "csat"]]);
});

Deno.test("panels: modalView rỗng khi không mở popup; nút Đóng và bấm ra ngoài đóng, bấm vào trong hộp thì không", () => {
  reset();
  const h = makeHandlers();
  assertEquals(modalView(h), null);
  state.modal = "draft";
  state.check = { ...CHECK, needs_reply: false };
  const calls = [];
  const overlay = modalView(makeHandlers(calls));
  assertEquals(overlay.className, "overlay");
  assertEquals(allText(overlay).includes("Draft — soạn tin trả lời"), true);
  assertEquals(allText(overlay).includes("Chưa có tin khách đang chờ"), true);
  buttonByText(overlay, "Đóng").onclick();
  overlay.onclick({ target: overlay });
  assertEquals(calls, [["closeModal"], ["closeModal"]]);
  const modalBox = walk(overlay).find((n) => n.className === "modal");
  overlay.onclick({ target: modalBox });
  assertEquals(calls.length, 2); // bấm vào trong hộp không đóng
});

Deno.test("panels: draft follow-up — không tin chờ nhưng ticket có update Dev thì cho soạn và hiện dòng giải thích", () => {
  reset();
  state.modal = "draft";
  state.check = { ...CHECK, needs_reply: false, jira: [{ issue_key: "TNT-9210", has_update: true }] };
  const overlay = modalView(makeHandlers());
  const t = allText(overlay);
  assertEquals(t.includes("Ticket TNT-9210 · Cập nhật mới từ Dev"), true);
  assertEquals(t.includes("Chưa có tin khách đang chờ trong conversation này."), false);
  assertEquals(Boolean(buttonByText(overlay, "Soạn tin trả lời")), true);
});

Deno.test("panels: không tin chờ và ticket không có update -> draft vẫn khoá như cũ", () => {
  reset();
  state.modal = "draft";
  state.check = { ...CHECK, needs_reply: false, jira: [{ issue_key: "TNT-9210", has_update: false }] };
  const overlay = modalView(makeHandlers());
  const t = allText(overlay);
  assertEquals(t.includes("Chưa có tin khách đang chờ trong conversation này."), true);
  assertEquals(Boolean(buttonByText(overlay, "Soạn tin trả lời")), false);
});

Deno.test("panels: REGRESSION — popup Private note phải hiện bộ nút chọn cách điền khi ô Note có chữ (choiceFor=note)", () => {
  reset();
  state.modal = "note";
  state.handoff = { note: "note nội bộ", cached: false };
  state.choice = true;
  state.choiceFor = "note";
  const overlay = modalView(makeHandlers());
  assertEquals(walk(overlay).some((n) => n.className === "insert-choice-marker"), true);
});

Deno.test("panels: popup Draft hiện bộ nút chọn cách điền cho draft (đối chứng với note)", () => {
  reset();
  state.modal = "draft";
  state.check = CHECK;
  state.composeOpen = false;
  state.draft = { output_id: 1, session_id: "s1", vm: toDraftViewModel({ draft: "Hi", warnings: [], verified: true, helpdesk_matches: 0 }) };
  state.choice = true;
  state.choiceFor = "draft";
  const overlay = modalView(makeHandlers());
  assertEquals(walk(overlay).some((n) => n.className === "insert-choice-marker"), true);
});

Deno.test("panels: popup Private note chưa có note → nút Viết private note gọi onHandoff(false), khoá khi handoff đang chạy", () => {
  reset();
  state.modal = "note";
  const calls = [];
  const overlay = modalView(makeHandlers(calls));
  const btn = buttonByText(overlay, "Viết private note");
  assertEquals(btn.disabled, false);
  btn.onclick();
  assertEquals(calls, [["handoff", false]]);
  state.busyAction = "handoff";
  const overlay2 = modalView(makeHandlers());
  assertEquals(buttonByText(overlay2, "Đang viết").disabled, true);
});

// ---------- sentiment / issues ----------
Deno.test("panels: insightPanel chưa có sentiment → chỉ hiện dòng trạng thái, KHÔNG còn nút Phân tích/Phân tích lại (Ethan bỏ 2026-10-29 — sentiment tự cập nhật qua đường nền)", () => {
  reset();
  const p = insightPanel(makeHandlers());
  assertEquals(allText(p).includes("Chưa có dữ liệu phân tích"), true);
  assertEquals(buttons(p).length, 0);
  assertEquals(buttonByText(p, "Phân tích"), undefined);
});

Deno.test("panels: insightPanel đang tự làm tươi (compute-on-view) → hiện dòng 'Đang cập nhật phân tích theo tin mới nhất…'", () => {
  reset();
  state.sentiment = { mood: "neutral", score: 50, urgency: "low", summary: "bản cũ", signals: [], confidence: 0.9 };
  state.sentimentRefreshing = true;
  assertEquals(allText(insightPanel(makeHandlers())).includes("Đang cập nhật phân tích theo tin mới nhất…"), true);
  state.sentimentRefreshing = false;
  assertEquals(allText(insightPanel(makeHandlers())).includes("Đang cập nhật phân tích"), false);
});

Deno.test("panels: insightPanel có sentiment frustrated + urgency high → nhãn mood, điểm, cảnh báo khẩn", () => {
  reset();
  state.sentiment = { mood: "frustrated", score: 18, urgency: "high", summary: "Khách chờ lâu", signals: ["Chờ 3 ngày"], confidence: 0.9 };
  state.sentimentMsgCount = 5;
  const p = insightPanel(makeHandlers());
  const t = allText(p);
  assertEquals(t.includes("Đang bực / chưa hài lòng"), true);
  assertEquals(t.includes("Mức khẩn cấp cao"), true);
  assertEquals(t.includes("tin của khách"), false); // hết dòng giải thích nguồn số liệu (Ethan bỏ 2026-10-26)
  assertEquals(t.includes("Chờ 3 ngày"), true);
  assertEquals(buttonByText(p, "Phân tích lại"), undefined); // nút phân tích thủ công đã bỏ (v9)
  // Điểm 18 nằm ở dải đỏ: nhãn mood + số điểm mang class band-red, hộp khẩn cũng đỏ.
  assertEquals(walk(p).some((n) => (n.className ?? "").includes("band-red")), true);
  assertEquals(walk(p).some((n) => (n.className ?? "").includes("urgent")), true);
});

Deno.test("panels: insightPanel màu theo DẢI ĐIỂM — 18 đỏ, 38 cam, 50 mặc định, 68 xanh dương, 88 xanh lá (v9)", () => {
  reset();
  const cases = [[18, "band-red"], [38, "band-orange"], [50, "band-default"], [68, "band-blue"], [88, "band-green"]];
  for (const [score, cls] of cases) {
    state.sentiment = { mood: "neutral", score, urgency: "low", summary: "", signals: [], confidence: 0.9 };
    const p = insightPanel(makeHandlers());
    const label = walk(p).find((n) => (n.className ?? "").includes("mood-label"));
    const num = walk(p).find((n) => (n.className ?? "").includes("score-num"));
    assertEquals((label.className ?? "").includes(cls), true, `score ${score}`);
    assertEquals((num.className ?? "").includes(cls), true, `score ${score}`);
  }
});

Deno.test("panels: issuesPanel render mỗi issue một thẻ ISSUE n từ sentiment.issues (kèm dòng bằng chứng); không còn khối tin khách nguyên văn trên panel (Ethan bỏ 2026-10-26 — đọc ngay trong chat, chừa chỗ cho Jira/Storefront); không issue thì ẩn module", () => {
  reset();
  state.check = CHECK;
  state.sentiment = { issues: [{ summary: "Khách bị trừ phí 2 lần", evidence: "charged twice" }, { summary: "Khách chưa được hoàn tiền", evidence: "" }] };
  const vm = toViewModel(CHECK, Date.now());
  const p = issuesPanel(vm);
  const t = allText(p);
  assertEquals(t.includes("ISSUE 1") && t.includes("ISSUE 2"), true);
  assertEquals(t.includes("— 2 issues"), true);
  assertEquals(t.includes("Khách bị trừ phí 2 lần"), true);
  assertEquals(t.includes("Khách nhắn: \"charged twice\""), true);
  assertEquals(t.includes("tin 1"), false);
  reset();
  state.check = { ...CHECK, topic: null, topic_label: null, needs_reply: false, unanswered: [] };
  assertEquals(issuesPanel(toViewModel(state.check, Date.now())), null);
});

// ---------- Jira ----------
const JIRA_ITEM = {
  issue_key: "TNT-1", url: "https://firegroup.atlassian.net/browse/TNT-1", summary: "Menu lỗi", status: "Done",
  has_update: true, status_changed: false, prev_status: null, awaiting_report: true, new_comments: [],
  recent_comments: [{ author: "Đình Lương", role: "tech", body: "Đã fix, chờ deploy.", created_at: "2026-10-20T09:00:00Z" }],
};
Deno.test("panels: jiraPanel ẩn khi module tắt; module bật mà chưa có ticket → card trống ghi rõ 'Không có ticket'", () => {
  reset();
  state.check = { modules: { jira: false, storefront: false }, jira: [JIRA_ITEM] };
  assertEquals(jiraPanel(makeHandlers()), null);
  state.check = { modules: { jira: true, storefront: false }, jira: [] };
  const p = jiraPanel(makeHandlers());
  assertEquals(p === null, false);
  assertEquals(allText(p).includes("Không có ticket"), true);
});

Deno.test("panels: jiraPanel hiện badge Cập nhật mới + Chờ báo khách, nút Sync gọi onJiraSync, gỡ liên kết 2 bước", () => {
  reset();
  state.check = { modules: { jira: true, storefront: false }, jira: [JIRA_ITEM] };
  const calls = [];
  const h = makeHandlers(calls);
  const p = jiraPanel(h);
  const t = allText(p);
  assertEquals(t.includes("Cập nhật mới") && t.includes("Chờ báo khách"), true);
  assertEquals(t.includes("Jira - Menu lỗi"), true); // tiêu đề mới, bỏ "Issue log"
  assertEquals(t.includes("Issue log"), false);
  assertEquals(t.includes("Done"), true); // pill Status
  assertEquals(t.includes("Tech · Đình Lương") && t.includes("Đã fix, chờ deploy."), true); // comment Tech mới nhất
  buttonByText(p, "Sync ngay").onclick();
  assertEquals(calls, [["jiraSync"]]);
  buttonByText(p, "✕ Gỡ").onclick();
  assertEquals(state.unlinkConfirm, "TNT-1");
  const p2 = jiraPanel(h); // render lại sau bước 1 (rerender thật ở app.js làm việc này)
  buttonByText(p2, "Gỡ liên kết này?").onclick();
  assertEquals(calls[calls.length - 1], ["jiraUnlink", "TNT-1"]);
  buttonByText(p2, "Huỷ").onclick();
  assertEquals(state.unlinkConfirm, "");
});

// ---------- Storefront ----------
Deno.test("panels: storefrontPanel ẩn khi module tắt; loading không có nút bấm nào (chỉ chờ)", () => {
  reset();
  state.check = { modules: { jira: false, storefront: false } };
  state.storefront = { status: "ok", store: "x.myshopify.com" };
  assertEquals(storefrontPanel(makeHandlers()), null);
  state.check = { modules: { jira: false, storefront: true } };
  state.storefront = { status: "loading" };
  const p = storefrontPanel(makeHandlers());
  assertEquals(allText(p).includes("Đang kiểm tra store này…"), true);
  assertEquals(buttons(p).length, 0);
});

Deno.test("panels: storefrontPanel lỗi → hiện message server + nút Thử lại gọi onStorefrontLoad; chưa cấu hình thì không có nút thử", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.storefront = { status: "error", error: "MCP sập" };
  const calls = [];
  const p = storefrontPanel(makeHandlers(calls));
  assertEquals(allText(p).includes("Không kiểm tra được storefront") && allText(p).includes("MCP sập"), true);
  buttonByText(p, "Thử lại").onclick();
  assertEquals(calls, [["sfLoad"]]);
  state.storefront = { status: "unconfigured", error: "chưa cấu hình" };
  assertEquals(buttons(storefrontPanel(makeHandlers())).length, 0);
});

Deno.test("panels: storefrontPanel need-shop → gõ vào ô giữ state, Enter hoặc nút Kiểm tra đều gọi load", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.storefront = { status: "need-shop" };
  const calls = [];
  const p = storefrontPanel(makeHandlers(calls));
  const input = walk(p).find((n) => n.tagName === "INPUT");
  input.oninput({ target: { value: "shop-a.myshopify.com" } });
  assertEquals(state.storefrontShopInput, "shop-a.myshopify.com");
  input.onkeydown({ key: "Enter" });
  buttonByText(p, "Kiểm tra store này").onclick();
  assertEquals(calls, [["sfLoad"], ["sfLoad"]]);
});

Deno.test("panels: storefrontPanel results → list đủ từng bug: pill trạng thái + nhãn ngắn + meta + đúng 1 link unit/bug", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  const unit = (loc, pg) => `https://sw.transcy.io/#/f/shop.myshopify.com%7C${loc}%7C${encodeURIComponent(pg)}%7C1440`;
  state.storefront = {
    status: "ok", store: "shop.myshopify.com", scannedAt: null, isStale: true,
    new: [{ title: "Graphic lost", kind: "Graphic lost", meta: "high · de · /products/a", fingerprint: "a".repeat(40), locale: "de", page: "/products/a", consoleLink: unit("de", "/products/a") }],
    acknowledged: [],
    inProgress: [{ title: "Layout degraded", kind: "Layout degraded", meta: "medium · fr · /", fingerprint: "b".repeat(40), locale: "fr", page: "/", consoleLink: unit("fr", "/") }],
  };
  const p = storefrontPanel(makeHandlers([]));
  const t = allText(p);
  assertEquals(t.includes("2 lỗi đã xác nhận"), true);
  assertEquals(t.includes("Mất hình ảnh") && t.includes("Lệch giao diện"), true);
  assertEquals(t.includes("Mới") && t.includes("Đang xử lý"), true);
  const hrefs = walk(p).filter((n) => n.tagName === "A").map((a) => a.attrs.href ?? a.href);
  assertEquals(hrefs.includes(unit("de", "/products/a")), true);
  assertEquals(hrefs.includes(unit("fr", "/")), true);
  assertEquals(hrefs.includes("https://sw.transcy.io"), true);
});

Deno.test("panels: storefront finding → hàng 3 link thẳng hàng 'Default page' / 'Issue page' / 'Console' đúng thứ tự (Ethan 2026-10-29)", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.storefront = {
    status: "ok", store: "shop.myshopify.com", scannedAt: null,
    new: [{ title: "Graphic lost", kind: "Graphic lost", meta: "high · de · /products/a", fingerprint: "a".repeat(40), locale: "de", page: "/products/a", consoleLink: "https://sw.transcy.io/#/f/x", pageLink: "https://shop.myshopify.com/products/a", issuePageLink: "https://shop.myshopify.com/de/products/a" }],
    acknowledged: [], inProgress: [],
  };
  const p = storefrontPanel(makeHandlers([]));
  const links = walk(p).filter((n) => n.tagName === "A");
  const byHref = (h) => links.find((a) => (a.attrs.href ?? a.href) === h);
  assertEquals(byHref("https://shop.myshopify.com/products/a")?.textContent ?? "", "Default page");
  assertEquals(byHref("https://shop.myshopify.com/de/products/a")?.textContent ?? "", "Issue page");
  assertEquals(byHref("https://sw.transcy.io/#/f/x")?.textContent ?? "", "Console");
  // Thứ tự trong DOM: Default page → Issue page → Console.
  const order = links.map((a) => a.textContent).filter((t) => ["Default page", "Issue page", "Console"].includes(t ?? ""));
  assertEquals(order, ["Default page", "Issue page", "Console"]);
});

Deno.test("panels: issuePageLink trùng pageLink → ẩn link Issue page, chỉ còn Default page + Console", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.storefront = {
    status: "ok", store: "shop.myshopify.com", scannedAt: null,
    new: [{ title: "Graphic lost", kind: "Graphic lost", meta: "high · en · /products/a", fingerprint: "b".repeat(40), locale: "en", page: "/products/a", consoleLink: "https://sw.transcy.io/#/f/y", pageLink: "https://shop.myshopify.com/products/a", issuePageLink: "https://shop.myshopify.com/products/a" }],
    acknowledged: [], inProgress: [],
  };
  const p = storefrontPanel(makeHandlers([]));
  const texts = walk(p).filter((n) => n.tagName === "A").map((a) => a.textContent);
  assertEquals(texts.includes("Issue page"), false);
  assertEquals(texts.includes("Default page") && texts.includes("Console"), true);
});

const SF_ONE = (over = {}) => ({
  status: "ok", store: "shop.myshopify.com", scannedAt: null,
  new: [{ title: "Graphic lost", kind: "Graphic lost", meta: "high · de · /products/a", fingerprint: "a".repeat(40), locale: "de", page: "/products/a", consoleLink: null }],
  acknowledged: [], inProgress: [],
  ...over,
});

Deno.test("panels: storefront menu thao tác — bấm dòng mở menu; thứ tự nút Take case · Fix · Dismiss (Ethan chốt live 2026-10-27)", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.storefront = SF_ONE();
  const fp = "a".repeat(40);
  const calls = [];
  const h = makeHandlers(calls);
  // Menu đóng: không có nút thao tác nào.
  let p = storefrontPanel(h);
  assertEquals(buttonByText(p, "Take case"), undefined);
  assertEquals(buttonByText(p, "Fix"), undefined);
  // Bấm vào dòng (không phải link/nút con) → gọi mở menu.
  const line = walk(p).find((n) => (n.className ?? "").includes("sf-line"));
  line.onclick({ target: { closest: () => null } });
  assertEquals(calls, [["sfMenu", fp]]);
  // Menu mở: đúng 3 nút theo thứ tự đã duyệt; Take case và Fix đều gọi thẳng act (Fix bấm là xong từ 2026-10-29), Dismiss mở form lý do.
  state.sfMenu = fp;
  calls.length = 0;
  p = storefrontPanel(h);
  const labels = buttons(p).map((b) => allText(b).trim()).filter((t) => ["Take case", "Fix", "Dismiss"].includes(t));
  assertEquals(labels, ["Take case", "Fix", "Dismiss"]);
  buttonByText(p, "Take case").onclick();
  buttonByText(p, "Fix").onclick();
  assertEquals(calls, [["sfAct", fp, "acknowledge"], ["sfAct", fp, "fixed"]]);
});

Deno.test("panels: storefront menu — finding Đang xử lý thì không hiện nút Take case nữa", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  const fp = "b".repeat(40);
  state.storefront = SF_ONE({
    new: [],
    inProgress: [{ title: "Layout degraded", kind: "Layout degraded", meta: "medium · fr · /", fingerprint: fp, locale: "fr", page: "/", consoleLink: null }],
  });
  state.sfMenu = fp;
  const p = storefrontPanel(makeHandlers([]));
  assertEquals(buttonByText(p, "Take case"), undefined);
  assertEquals(Boolean(buttonByText(p, "Fix")), true);
});

Deno.test("panels: storefront menu — Fix bấm là xong: gọi act fixed ngay, KHÔNG mở form (Ethan 2026-10-29)", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.storefront = SF_ONE();
  const fp = "a".repeat(40);
  state.sfMenu = fp;
  const calls = [];
  const h = makeHandlers(calls);
  const p = storefrontPanel(h);
  assertEquals(walk(p).some((n) => n.tagName === "TEXTAREA"), false);
  buttonByText(p, "Fix").onclick();
  assertEquals(calls, [["sfAct", fp, "fixed"]]);
});

Deno.test("panels: storefront form Dismiss — chỉ cần lý do, ghi chú không bắt buộc; chip chọn lý do ghi vào state (Ethan 2026-10-29)", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.storefront = SF_ONE();
  const fp = "a".repeat(40);
  state.sfMenu = fp;
  state.sfForm = { fingerprint: fp, kind: "dismiss" };
  const h = makeHandlers([]);
  let p = storefrontPanel(h);
  assertEquals(buttonByText(p, "Xác nhận Dismiss").disabled, true); // chưa chọn lý do
  buttonByText(p, "Báo sai, trang vẫn ổn").onclick();
  assertEquals(state.sfReason, "false_signal");
  p = storefrontPanel(h);
  assertEquals(buttonByText(p, "Xác nhận Dismiss").disabled, false);
});

Deno.test("panels: storefront finding vừa đóng — nằm ở tab Đã đóng: pill Đã đóng + ghi chú kèm tên CS + nút Mở lại; đầu thẻ trừ số đã đóng", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.operatorName = "Ethan Nguyen";
  state.storefront = SF_ONE({
    acknowledged: [{ title: "Region missing", kind: "Region missing", meta: "critical · ja · /", fingerprint: "b".repeat(40), locale: "ja", page: "/", consoleLink: null }],
  });
  const fp = "a".repeat(40);
  state.sfClosed = { [fp]: { via: "fixed", note: "Đã sửa trong theme" } };
  const calls = [];
  const h = makeHandlers(calls);
  let p = storefrontPanel(h);
  let t = allText(p);
  assertEquals(t.includes("1 lỗi đã xác nhận"), true); // tổng 2, đã đóng 1
  assertEquals(t.includes("Đang mở · 1") && t.includes("Đã đóng · 1"), true); // hai tab kèm số
  assertEquals(t.includes("Đã sửa trong theme"), false); // finding đã đóng chưa hiện ở tab Đang mở
  buttonByText(p, "Đã đóng · 1").onclick();
  assertEquals(state.sfTab, "closed");
  p = storefrontPanel(h);
  t = allText(p);
  assertEquals(t.includes("Đã đóng") && t.includes("Fix · Ethan Nguyen: “Đã sửa trong theme”"), true);
  buttonByText(p, "Mở lại").onclick();
  assertEquals(calls.filter((c) => c[0] === "sfAct"), [["sfAct", fp, "undo"]]);
});

Deno.test("panels: storefront tab — mặc định Đang mở; bấm tab Đã đóng khi chưa đóng lỗi nào thì hiện dòng trống", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.storefront = SF_ONE();
  const h = makeHandlers([]);
  let p = storefrontPanel(h);
  let t = allText(p);
  assertEquals(t.includes("Đang mở · 1") && t.includes("Đã đóng · 0"), true);
  assertEquals(t.includes("Mất hình ảnh"), true); // finding đang mở hiện sẵn
  buttonByText(p, "Đã đóng · 0").onclick();
  assertEquals(state.sfTab, "closed");
  p = storefrontPanel(h);
  assertEquals(allText(p).includes("Chưa có lỗi nào được đóng."), true);
});

Deno.test("panels: storefront tab — đóng hết lỗi đang mở thì mặc định mở sẵn tab Đã đóng", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  state.operatorName = "Ethan Nguyen";
  state.storefront = SF_ONE();
  const fp = "a".repeat(40);
  state.sfClosed = { [fp]: { via: "dismiss", note: "Trang vẫn ổn" } };
  const p = storefrontPanel(makeHandlers([]));
  const t = allText(p);
  assertEquals(t.includes("Đang mở · 0") && t.includes("Đã đóng · 1"), true);
  assertEquals(t.includes("Dismiss · Ethan Nguyen: “Trang vẫn ổn”"), true); // hiện ngay, không cần bấm tab
  assertEquals(Boolean(buttonByText(p, "Mở lại")), true);
});

Deno.test("panels: storefrontPanel list — finding gom trùng căn nguyên vẫn hiện ĐỦ từng finding (3 finding = 3 dòng, 3 link riêng)", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  const F = (fp, locale) => ({
    title: "Region missing", meta: `critical · ${locale} · /`, fingerprint: fp, kind: "Region missing",
    locale, page: "/", severity: "critical", text: null,
    consoleLink: `https://sw.transcy.io/#/f/amirobeauty.com%7C${locale}%7C%2F%7C1440`,
  });
  const [fa, fb, fc] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  state.storefront = {
    status: "ok", store: "amirobeauty.com", scannedAt: null,
    new: [F(fa, "ja"), F(fb, "zh"), F(fc, "es")], acknowledged: [], inProgress: [],
  };
  const p = storefrontPanel(makeHandlers([]));
  const t = allText(p);
  assertEquals(t.includes("3 lỗi đã xác nhận"), true);
  assertEquals(t.split("Thiếu vùng nội dung").length - 1, 3);
  const hrefs = walk(p).filter((n) => n.tagName === "A").map((a) => a.attrs.href ?? a.href);
  for (const loc of ["ja", "zh", "es"]) {
    assertEquals(hrefs.includes(`https://sw.transcy.io/#/f/amirobeauty.com%7C${loc}%7C%2F%7C1440`), true, loc);
  }
});

Deno.test("panels: issuesPanel badge Storefront — từ bản chụp trong check khi module chưa nạp; cổng tắt thì không hiện badge", () => {
  reset();
  state.check = { ...CHECK, modules: { jira: false, storefront: true }, storefront_status: { watched: true, open_total: 4 } };
  state.sentiment = { signals: ["Vấn đề A"] };
  const vm = toViewModel(state.check, Date.now());
  let t = allText(issuesPanel(vm));
  assertEquals(t.includes("Storefront: 4 lỗi đang mở"), true);
  // Cổng module tắt (server không bật) → không rò số liệu SW ra badge.
  state.check = { ...CHECK, modules: { jira: false, storefront: false }, storefront_status: { watched: true, open_total: 4 } };
  t = allText(issuesPanel(toViewModel(state.check, Date.now())));
  assertEquals(t.includes("lỗi đang mở"), false);
  // Module đã nạp: badge lấy tổng finding thật từ dữ liệu trực tiếp, thắng bản chụp.
  state.check = { ...CHECK, modules: { jira: false, storefront: true }, storefront_status: { watched: true, open_total: 4 } };
  state.storefront = { status: "ok", store: "s.myshopify.com", scannedAt: null, new: [{ title: "Lỗi 1", meta: "" }, { title: "Lỗi 2", meta: "" }], acknowledged: [], inProgress: [] };
  t = allText(issuesPanel(toViewModel(state.check, Date.now())));
  assertEquals(t.includes("Storefront: 2 lỗi đang mở"), true);
});

Deno.test("panels: popup Mẫu giải thích — hiện đoạn mẫu + nút Điền gọi sendExplainInsert('auto') khi bridge ready, khoá khi chưa ready", () => {
  reset();
  state.modal = "explain";
  state.explainFinding = { fingerprint: "a".repeat(40), kind: "Region missing", locale: "ja", page: "/", text: null, title: "Region missing" };
  state.explainText = "Hi, thank you for letting us know. We've checked on our side and confirmed that a section of content is missing on / in the ja version of the store.";
  state.bridge = "outdated";
  let overlay = modalView(makeHandlers());
  assertEquals(allText(overlay).includes("Mẫu giải thích cho khách"), true);
  assertEquals(allText(overlay).includes("a section of content is missing"), true);
  assertEquals(buttonByText(overlay, "Điền vào ô Reply").disabled, true);
  state.bridge = "ready";
  const calls = [];
  overlay = modalView(makeHandlers(calls));
  const btn = buttonByText(overlay, "Điền vào ô Reply");
  assertEquals(btn.disabled, false);
  btn.onclick();
  assertEquals(calls, [["explainInsert", "auto"]]);
});

// ---------- CSAT / Review ----------
Deno.test("panels: csatPanel — khách frustrated + chat chưa đóng thì cảnh báo điểm thấp nhưng nút Send vẫn bấm được; chat đã đóng thì hết cảnh báo", () => {
  reset();
  state.sentiment = { mood: "frustrated", score: 10 };
  state.check = { conversation_state: "open" };
  let p = csatPanel(makeHandlers());
  assertEquals(allText(p).includes("dễ nhận điểm thấp"), true);
  assertEquals(buttonByText(p, "Send CSAT Survey").disabled, false);
  state.check = { conversation_state: "resolved" };
  p = csatPanel(makeHandlers());
  assertEquals(allText(p).includes("điểm thấp"), false);
});

Deno.test("panels: csatPanel — đã gửi thì nút đổi thành 'Gửi lại CSAT Survey' và VẪN bấm được (Ethan 2026-10-26: không khoá nút, team tự quyết khi nào xin lại); gửi lỗi thì hiện hộp lỗi + nút Thử lại gọi onSurvey", () => {
  reset();
  state.csat = { sent: true, sent_at: "2026-10-23T08:00:00Z" };
  let p = csatPanel(makeHandlers());
  assertEquals(buttonByText(p, "Gửi lại CSAT Survey").disabled, false);
  assertEquals(allText(p).includes("Đã gửi lúc"), true);
  assertEquals(allText(p).includes("Nút gửi đã tắt"), false);
  reset();
  state.csatError = true;
  state.csatErrorMsg = "n8n gate 500";
  const calls = [];
  p = csatPanel(makeHandlers(calls));
  assertEquals(allText(p).includes("Không gửi được") && allText(p).includes("n8n gate 500"), true);
  buttonByText(p, "Thử lại").onclick();
  assertEquals(calls, [["survey"]]);
});

Deno.test("panels: popup CSAT nhánh review — extension outdated/missing thì nút Điền khoá, ready thì bấm gọi sendReviewInsert('auto')", () => {
  reset();
  state.modal = "csat";
  state.csatChoice = "review";
  state.bridge = "outdated";
  let overlay = modalView(makeHandlers());
  assertEquals(buttonByText(overlay, "Điền vào ô Reply").disabled, true);
  state.bridge = "ready";
  const calls = [];
  overlay = modalView(makeHandlers(calls));
  const btn = buttonByText(overlay, "Điền vào ô Reply");
  assertEquals(btn.disabled, false);
  btn.onclick();
  assertEquals(calls, [["reviewInsert", "auto"]]);
});

// ---------- khoá điền theo bridge (draft + note) ----------
Deno.test("panels: draftPanel — bridge chưa ready thì KHÔNG có nút điền (dù draft đã sẵn), ready mới có và bấm gọi onEditInCrisp", () => {
  reset();
  state.draft = { output_id: 1, session_id: "s1", vm: toDraftViewModel({ draft: "Xin chào [[CS: tên]]", warnings: [], verified: false, helpdesk_matches: 0 }) };
  for (const b of ["outdated", "missing", "checking"]) {
    state.bridge = b;
    assertEquals(buttonByText(draftPanel(makeHandlers()), "Điền vào Reply"), undefined, b);
    assertEquals(allText(draftPanel(makeHandlers())).includes("Xin chào"), true, b);
  }
  state.bridge = "ready";
  const calls = [];
  const btn = buttonByText(draftPanel(makeHandlers(calls)), "Điền vào Reply");
  assertEquals(btn.disabled, false);
  btn.onclick();
  assertEquals(calls, [["edit"]]);
  state.draftPlacement = "inserted";
  assertEquals(Boolean(buttonByText(draftPanel(makeHandlers()), "Điền lại vào Reply")), true);
  assertEquals(buttonByText(draftPanel(makeHandlers()), "Sửa trong Crisp"), undefined);
});

Deno.test("panels: handoffPanel — bridge chưa ready thì không có nút Điền vào ô Note (chỉ còn Viết lại), ready thì bấm gọi onInsertNote", () => {
  reset();
  state.handoff = { note: "note bàn giao", cached: true };
  state.bridge = "outdated";
  let p = handoffPanel(makeHandlers());
  assertEquals(buttonByText(p, "Điền vào ô Note"), undefined);
  assertEquals(Boolean(buttonByText(p, "Viết lại")), true);
  state.bridge = "ready";
  const calls = [];
  p = handoffPanel(makeHandlers(calls));
  buttonByText(p, "Điền vào ô Note").onclick();
  assertEquals(calls, [["insertNote"]]);
});

Deno.test("panels: extensionHint — missing thì có nút Kiểm tra lại gọi detectExtension; outdated thì không có nút đó, chỉ hướng dẫn cài lại; ready/checking thì ẩn", () => {
  reset();
  state.bridge = "missing";
  const calls = [];
  const hint = extensionHint(makeHandlers(calls));
  buttonByText(hint, "Kiểm tra lại").onclick();
  assertEquals(calls, [["detect"]]);
  state.bridge = "outdated";
  const hint2 = extensionHint(makeHandlers());
  assertEquals(allText(hint2).includes("Extension cần cập nhật"), true);
  assertEquals(buttonByText(hint2, "Kiểm tra lại"), undefined);
  state.bridge = "ready";
  assertEquals(extensionHint(makeHandlers()), null);
  state.bridge = "checking";
  assertEquals(extensionHint(makeHandlers()), null);
});

Deno.test("panels: extensionHint — bridge ready nhưng version cũ hơn bản kỳ vọng thì cảnh báo kèm số version; version khớp thì ẩn", () => {
  reset();
  state.bridge = "ready";
  state.bridgeVersion = "1.2.0";
  const hint = extensionHint(makeHandlers());
  assertEquals(hint === null, false);
  assertEquals(allText(hint).includes("Extension đang ở bản cũ v1.2.0"), true);
  assertEquals(allText(hint).includes("1.2.6"), true);
  state.bridgeVersion = "1.2.6";
  assertEquals(extensionHint(makeHandlers()), null);
  state.bridgeVersion = "";
  assertEquals(extensionHint(makeHandlers()), null);
});

Deno.test("panels: extensionHint — hai bản extension cùng chạy thì cảnh báo xung đột, ưu tiên hơn cả trạng thái ready", () => {
  reset();
  state.bridge = "ready";
  state.bridgeVersion = "1.2.2";
  state.bridgeConflict = true;
  const hint = extensionHint(makeHandlers());
  assertEquals(hint === null, false);
  assertEquals(allText(hint).includes("Đang có 2 bản extension cùng chạy"), true);
  assertEquals(allText(hint).includes("gấp đôi"), true);
});

// ---------- Knowledge Base Asking ----------
Deno.test("panels: knowledgePanel — Enter trong ô hỏi gọi onAsk; có đáp án thì nút Soạn đưa đúng answer cho onAskCompose", () => {
  reset();
  const calls = [];
  let p = knowledgePanel(makeHandlers(calls));
  const input = walk(p).find((n) => n.tagName === "TEXTAREA");
  let prevented = false;
  input.onkeydown({ key: "Enter", shiftKey: false, preventDefault: () => { prevented = true; } });
  assertEquals(prevented, true);
  assertEquals(calls, [["ask"]]);
  state.askResult = { question: "đổi tiền tệ?", found: true, answer: "Bật Auto Currency", sources: [{ title: "Currency", url: "https://help.transcy.io/a" }] };
  p = knowledgePanel(makeHandlers(calls));
  buttonByText(p, "Soạn thành tin trả lời khách").onclick();
  assertEquals(calls[calls.length - 1], ["askCompose", "Bật Auto Currency"]);
});

Deno.test("panels: knowledgePanel — không tìm thấy thì KHÔNG hiện khối nào thêm (Ethan chốt 2026-10-27: bỏ thẻ không tìm thấy + 2 nút kèm)", () => {
  reset();
  state.askResult = { question: "xyz", found: false, answer: "", sources: [] };
  const p = knowledgePanel(makeHandlers([]));
  assertEquals(allText(p).includes("không tìm thấy bài nào"), false);
  assertEquals(buttonByText(p, "Thử từ khoá khác"), undefined);
  assertEquals(buttonByText(p, "Ghi private note hỏi quản lý"), undefined);
  assertEquals(buttonByText(p, "Soạn thành tin trả lời khách"), undefined);
});

Deno.test("panels: draft — không tin chờ, không ticket, nhưng hội thoại ĐÃ có tin khách (ca email auto-reply) thì vẫn cho soạn", () => {
  reset();
  state.modal = "draft";
  state.check = { ...CHECK, needs_reply: false, jira: [], last_customer_at: "2026-10-27T02:00:00.000Z" };
  const overlay = modalView(makeHandlers());
  const t = allText(overlay);
  assertEquals(t.includes("Chưa có tin khách đang chờ trong conversation này."), false);
  assertEquals(Boolean(buttonByText(overlay, "Soạn tin trả lời")), true);
});

Deno.test("panels: thanh chọn Thay thế/Huỷ đang mở thì nút điền gốc ẨN (hết hai lớp nút chồng nhau — ca live 2026-10-26)", () => {
  reset();
  state.modal = "csat";
  state.csatChoice = "review";
  state.check = { ...CHECK, review_template: { source: "default", text: "Hi there, review please", suggestion: null } };
  // Chưa hỏi thay thế: nút Điền hiện.
  let overlay = modalView(makeHandlers());
  assertEquals(Boolean(buttonByText(overlay, "Điền vào ô Reply")), true);
  // Đang hỏi thay thế cho review: nút Điền gốc biến mất, chỉ còn thanh chọn.
  state.choice = true;
  state.choiceFor = "review";
  overlay = modalView(makeHandlers());
  assertEquals(buttonByText(overlay, "Điền vào ô Reply"), undefined);
});
