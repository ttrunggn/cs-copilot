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
const { commandsRow, csatPanel, draftCompose, draftPanel, extensionHint, handoffPanel, insightPanel, issuesPanel, jiraPanel, knowledgePanel, modalView, profileFooter, storefrontPanel } = await import("./panels.js");

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
  });
}
function makeHandlers(calls = []) {
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  return {
    onGenerate: rec("generate"), onHandoff: rec("handoff"), onAnalyze: rec("analyze"),
    onSurvey: rec("survey"), onAsk: rec("ask"), onAskCompose: rec("askCompose"), onAskRetry: rec("askRetry"),
    onEditInCrisp: rec("edit"), onInsertNote: rec("insertNote"), onJiraSync: rec("jiraSync"),
    onJiraUnlink: rec("jiraUnlink"), onStorefrontLoad: rec("sfLoad"), onStorefrontFinding: rec("sfFinding"),
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

Deno.test("panels: profileFooter nói rõ nguồn giọng, độ phủ dữ liệu học và nguồn template review", () => {
  reset();
  state.check = { ...CHECK, workspace: "Transcy", profile_coverage: { conversations_used: 42, learned_at: "2026-10-20T00:00:00Z" }, review_template: { source: "profile", text: "x" } };
  const t = allText(profileFooter());
  assertEquals(t.includes("Lan"), true);
  assertEquals(t.includes("Giọng: theo profile của bạn"), true);
  assertEquals(t.includes("Dữ liệu học: 42 cuộc trò chuyện"), true);
  assertEquals(t.includes("Template review: theo profile của bạn"), true);
  assertEquals(t.includes("Product knowledge: theo workspace Transcy"), true);
  // CS chưa có dữ liệu học: phải nói thẳng là chưa đủ + đang dùng mặc định, không im lặng
  state.check = { ...CHECK, workspace: "Transcy", profile_source: "best", profile_coverage: null, review_template: { source: "default", text: "x" } };
  const t2 = allText(profileFooter());
  assertEquals(t2.includes("profile mẫu của team"), true);
  assertEquals(t2.includes("Dữ liệu học: chưa đủ — đang dùng mặc định"), true);
  assertEquals(t2.includes("Template review: mặc định của workspace"), true);
});

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
Deno.test("panels: insightPanel chưa có sentiment → trạng thái rỗng + nút Phân tích gọi onAnalyze(true); đang bận thì khoá", () => {
  reset();
  const calls = [];
  const p = insightPanel(makeHandlers(calls));
  assertEquals(allText(p).includes("Chưa có dữ liệu phân tích"), true);
  const btn = buttonByText(p, "Phân tích");
  assertEquals(btn.disabled, false);
  btn.onclick();
  assertEquals(calls, [["analyze", true]]);
  state.busyAction = "ask";
  assertEquals(buttonByText(insightPanel(makeHandlers()), "Phân tích").disabled, true);
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
  assertEquals(Boolean(buttonByText(p, "Phân tích lại")), true);
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
Deno.test("panels: jiraPanel ẩn khi module tắt; module bật mà chưa có ticket → card trống 'Không có ticket Jira.'", () => {
  reset();
  state.check = { modules: { jira: false, storefront: false }, jira: [JIRA_ITEM] };
  assertEquals(jiraPanel(makeHandlers()), null);
  state.check = { modules: { jira: true, storefront: false }, jira: [] };
  const p = jiraPanel(makeHandlers());
  assertEquals(p === null, false);
  assertEquals(allText(p).includes("Không có ticket Jira."), true);
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

Deno.test("panels: storefrontPanel results → 3 nhóm đúng nhãn/số, bấm finding mở chi tiết, stale có cảnh báo", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  const fp = "a".repeat(40);
  state.storefront = {
    status: "ok", store: "shop.myshopify.com", scannedAt: null, isStale: true,
    new: [{ title: "Lỗi mới", meta: "de", fingerprint: fp }], acknowledged: [], inProgress: [{ title: "Đang xử lý", meta: "" }],
  };
  const calls = [];
  const p = storefrontPanel(makeHandlers(calls));
  const t = allText(p);
  assertEquals(t.includes("Storefront Watch — 2 issues"), true);
  assertEquals(t.includes("Mới") && t.includes("Đã xác nhận") && t.includes("Đang xử lý"), true);
  assertEquals(t.includes("Kết quả cũ"), true);
  buttonByText(p, "Lỗi mới").onclick();
  assertEquals(calls, [["sfFinding", fp]]);
});

Deno.test("panels: storefrontPanel gom finding trùng căn nguyên — đầu mục + chip locale, từng entry có deep-link console đúng fingerprint và nút Mẫu giải thích riêng", () => {
  reset();
  state.check = { modules: { jira: false, storefront: true } };
  const F = (fp, locale) => ({
    title: "Region missing", meta: `critical · ${locale} · /`, fingerprint: fp, kind: "Region missing",
    locale, page: "/", severity: "critical", text: null, consoleLink: `https://sw.transcy.io/#/f/${fp}`,
  });
  const [fa, fb, fc] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  state.storefront = {
    status: "ok", store: "amirobeauty.com", scannedAt: null,
    new: [F(fa, "ja"), F(fb, "zh"), F(fc, "es")], acknowledged: [], inProgress: [],
  };
  const calls = [];
  const p = storefrontPanel(makeHandlers(calls));
  const t = allText(p);
  // Tổng ở header module đếm finding THẬT (3), không đếm mục đã gom (1).
  assertEquals(t.includes("Storefront Watch — 3 issues"), true);
  // Đầu mục đã gom: số ngôn ngữ + đủ 3 chip locale.
  assertEquals(t.includes("3 ngôn ngữ"), true);
  for (const l of ["ja", "zh", "es"]) assertEquals(t.includes(l), true, l);
  // Deep-link: mỗi entry một link console trỏ đúng fingerprint của nó.
  const links = walk(p).filter((n) => n.tagName === "A");
  assertEquals(links.map((a) => a.attrs.href ?? a.href), [
    `https://sw.transcy.io/#/f/${fa}`, `https://sw.transcy.io/#/f/${fb}`, `https://sw.transcy.io/#/f/${fc}`,
  ]);
  // Bấm entry thứ hai → mở chi tiết đúng fingerprint của entry đó.
  const entryButtons = buttons(p).filter((b) => allText(b).includes("critical"));
  entryButtons[1].onclick();
  assertEquals(calls, [["sfFinding", fb]]);
  // Nút Mẫu giải thích của entry → onExplain nhận đúng finding (kind/locale/page của entry đó).
  calls.length = 0;
  const explainBtns = buttons(p).filter((b) => allText(b).includes("Mẫu giải thích"));
  assertEquals(explainBtns.length, 3);
  explainBtns[0].onclick();
  assertEquals(calls, [["explain", { fingerprint: fa, kind: "Region missing", locale: "ja", page: "/", text: null, title: "Region missing" }]]);
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
  assertEquals(allText(hint).includes("1.2.2"), true);
  state.bridgeVersion = "1.2.2";
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

Deno.test("panels: knowledgePanel — không tìm thấy thì có Thử từ khoá khác + Ghi private note hỏi quản lý, không có nút Soạn", () => {
  reset();
  state.askResult = { question: "xyz", found: false, answer: "", sources: [] };
  const calls = [];
  const p = knowledgePanel(makeHandlers(calls));
  assertEquals(allText(p).includes("không tìm thấy bài nào"), true);
  assertEquals(buttonByText(p, "Soạn thành tin trả lời khách"), undefined);
  buttonByText(p, "Thử từ khoá khác").onclick();
  buttonByText(p, "Ghi private note hỏi quản lý").onclick();
  assertEquals(calls, [["askRetry"], ["handoff", false]]);
});
