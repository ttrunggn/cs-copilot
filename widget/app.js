import { actionButtonState, askAnswerToHint, countPlaceholders, describeShape, mapError, operatorIdFrom, readContext, toAskViewModel, toDraftViewModel, toViewModel } from "./core.js";
import { buttonContent, el, show } from "./dom.js";
import { state } from "./state.js";
import { createExtensionClient } from "./extension-client.js";
import { chipsRow, csatPanel, draftPanel, extensionHint, handoffPanel, insightPanel, jiraPanel, knowledgePanel, pendingMessageCard, storefrontPanel, storefrontStrip, suggestionCard, summaryPanel } from "./panels.js";

// Điều phối của widget: gọi API copilot, giữ luồng render/load và khởi động.
// Trạng thái nằm ở state.js, giao tiếp extension ở extension-client.js,
// các panel hiển thị ở panels.js, helper DOM ở dom.js.
const API = "https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot";
const requestedTheme = new URLSearchParams(location.search).get("theme");
if (requestedTheme === "light" || requestedTheme === "dark") document.documentElement.dataset.theme = requestedTheme;

const extension = createExtensionClient(render);
const handlers = { copy, onGenerate, onHandoff, onAnalyze, onSurvey, onAsk, onAskCompose, onAskRetry, saveDraftEdit, toggleDraftEdit, sendInsert: extension.sendInsert, detectExtension: extension.detectExtension };

/** Lưu bản draft CS vừa sửa tại chỗ (null = huỷ sửa). Đếm lại chỗ [[CS: …]] theo bản mới. */
function saveDraftEdit(text) {
  if (state.draft && typeof text === "string") {
    state.draft.vm = { ...state.draft.vm, text, todos: countPlaceholders(text) };
    state.draftPlacement = "";
  }
  state.draftEditing = false;
  render();
}

function toggleDraftEdit() {
  state.draftEditing = true;
  render();
}

function showMessage(text, retry) {
  show(el("section", { className: "state-card" }, [
    el("p", { className: "state-title", textContent: text }),
    retry ? el("button", { className: "button-secondary", textContent: "Thử lại", onclick: load }) : null,
  ]));
}

/** Trạng thái chờ lần đầu (chưa có dữ liệu gì để hiện): khung xương đúng bố cục
 *  panel thay cho dòng chữ trơ; trạng thái lỗi vẫn dùng showMessage như cũ. */
function showLoading(text) {
  show(
    el("div", { className: "sk" }, [
      el("div", { className: "sk-block sk-head" }),
      el("div", { className: "sk-block sk-card" }),
      el("div", { className: "sk-block sk-card-sm" }),
      el("div", { className: "sk-block sk-card" }),
    ]),
    el("p", { className: "sk-status", textContent: text }),
  );
}

let copyTimer = null;

/** Copy + phản hồi ngay tại nút vừa bấm (key: draft | handoff | summary | ask). */
async function copy(text, key = "") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = el("textarea", { value: text });
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  if (state.draft && text === state.draft.vm.text) state.draftPlacement = "copied";
  state.notice = "Đã copy, dán vào ô Reply bằng Ctrl+V";
  if (key) {
    state.copiedKey = key;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      state.copiedKey = "";
      render();
    }, 1600);
  }
  render();
}

// ---------- API ----------

async function call(action, extra = {}) {
  const ctx = readContext(location.search);
  if ("error" in ctx) throw { message: ctx.error };
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ website_id: ctx.websiteId, session_id: ctx.sessionId, crisp_token: ctx.crispToken, operator_id: state.operatorId, action, ...extra }),
  }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  // Response về khi CS đã chuyển sang chat khác thì bỏ (spec 6.4 #2).
  if (readContext(location.search).sessionId !== ctx.sessionId) throw { stale: true };
  if (!res || !res.ok) throw mapError(res ? res.status : 0, body);
  return body;
}

async function onGenerate(force) {
  if (state.busy) return; // một action API tại một thời điểm — chặn cả Enter/bấm đúp lọt qua nút đã khoá
  state.busyAction = "generate";
  state.busy = force ? "Đang soạn lại…" : "Đang soạn…";
  state.notice = "";
  state.choice = false;
  render();
  try {
    const sessionId = readContext(location.search).sessionId;
    const extra = {};
    if (force) extra.force = true;
    const hint = state.hint.trim();
    if (hint) extra.hint = hint;
    if (state.tone !== "default") extra.tone = state.tone;
    const out = await call("generate", extra);
    state.draft = { output_id: out.output_id, session_id: sessionId, vm: toDraftViewModel(out) };
    if (out.sentiment) state.sentiment = out.sentiment;
    state.draftPlacement = "";
    state.draftEditing = false;
    state.busy = "";
    state.busyAction = "";
    render();
    if (state.bridge === "ready") extension.sendInsert("auto");
  } catch (e) {
    state.busy = "";
    state.busyAction = "";
    if (!e.stale) state.notice = e.message ?? "Không soạn được, thử lại sau";
    render();
  }
}

async function onAnalyze(force) {
  if (state.busy) return;
  state.busyAction = "analyze";
  state.busy = "Đang phân tích tâm trạng…";
  state.notice = "";
  render();
  try {
    const out = await call("analyze", force ? { force: true } : {});
    state.sentiment = out.sentiment;
    if (typeof out.msg_count === "number") state.sentimentMsgCount = out.msg_count;
    if (!out.sentiment) state.notice = "Chưa đủ tin nhắn của khách để phân tích.";
  } catch (e) {
    if (!e.stale) state.notice = e.message ?? "Không phân tích được, thử lại sau";
  }
  state.busy = "";
  state.busyAction = "";
  render();
}

async function onSurvey() {
  if (state.busy) return;
  state.busyAction = "survey";
  state.busy = "Đang gửi survey…";
  state.notice = "";
  state.csatError = false;
  render();
  try {
    const out = await call("survey");
    if (out.sent) {
      state.csat = { sent: true, sent_at: out.sent_at };
      state.csatError = false;
      state.notice = out.already ? "Survey đã được gửi trước đó rồi." : "Đã gửi CSAT survey cho khách.";
    } else {
      // Panel CSAT hiện trạng thái lỗi riêng kèm nút Thử lại (board 5).
      state.csatError = true;
    }
  } catch (e) {
    if (!e.stale) state.csatError = true;
  }
  state.busy = "";
  state.busyAction = "";
  render();
}

/** Hỏi tài liệu (board 3): gửi câu hỏi lên action ask, kết quả vào state.askResult. */
async function onAsk() {
  if (state.busy) return; // Enter trong ô nhập cũng đi qua đây — chặn gọi ask song song
  const question = state.askQuestion.trim();
  if (!question) {
    state.notice = "Hãy nhập câu hỏi để tìm trong tài liệu.";
    render();
    return;
  }
  state.busyAction = "ask";
  state.busy = "Đang tìm tài liệu…";
  state.notice = "";
  render();
  try {
    const out = await call("ask", { question });
    state.askResult = { question, ...toAskViewModel(out) };
  } catch (e) {
    if (!e.stale) state.notice = e.message ?? "Không tìm được tài liệu, thử lại sau";
  }
  state.busy = "";
  state.busyAction = "";
  render();
}

/** Đáp án tài liệu → ý của CS trong draft panel, rồi generate như bấm Soạn tin. */
function onAskCompose(answer) {
  state.hint = askAnswerToHint(answer);
  onGenerate(false);
}

/** "Thử từ khoá khác": xoá câu hỏi + kết quả cũ và đặt lại con trỏ vào ô nhập. */
function onAskRetry() {
  state.askQuestion = "";
  state.askResult = null;
  render();
  document.querySelector(".knowledge-card .field")?.focus();
}

async function onHandoff(force) {
  if (state.busy) return;
  state.busyAction = "handoff";
  state.busy = "Đang viết handoff…";
  state.notice = "";
  render();
  try {
    const out = await call("handoff", force ? { force: true } : {});
    state.handoff = { note: out.note, posted: out.posted, cached: out.cached };
    state.busy = "";
    state.busyAction = "";
    render();
  } catch (e) {
    state.busy = "";
    state.busyAction = "";
    if (!e.stale) state.notice = e.message ?? "Không tạo được handoff, thử lại sau";
    render();
  }
}

// ---------- render ----------

function render() {
  if (!state.check) return;
  const vm = toViewModel(state.check, Date.now());
  const genBtn = actionButtonState(state.busyAction, "generate");
  const noteBtn = actionButtonState(state.busyAction, "handoff");
  show(
    el("header", { className: "inbox-header" }, [
      el("div", {}, [el("h1", { textContent: vm.header }), el("p", { className: "subtitle", textContent: vm.subtitle })]),
      el("button", { className: "refresh-button", textContent: "↻", title: "Làm mới", onclick: load }),
    ]),
    vm.stale ? el("p", { className: "stale-line", textContent: "Dữ liệu có thể chậm vài phút" }) : null,
    chipsRow(),
    storefrontStrip(),
    insightPanel(handlers),
    summaryPanel(handlers),
    vm.pendingMessages.length ? el("section", { className: "pending-section" }, [
      ...vm.pendingMessages.map(pendingMessageCard),
      vm.hiddenPendingCount ? el("p", { className: "muted", textContent: `Đang hiện ${vm.pendingMessages.length} trong ${vm.pendingCount} tin` }) : null,
    ]) : el("div", { className: "empty-state" }, [
      el("h2", { textContent: "Hết tin chờ rồi" }),
      el("p", { className: "subtitle", textContent: vm.subtitle }),
    ]),
    !state.draft && vm.pendingMessages.length ? suggestionCard(handlers, vm.pendingMessages[vm.pendingMessages.length - 1].text) : null,
    el("div", { className: "actions" }, [
      el("button", { className: "button-primary compose-button", disabled: genBtn.disabled, onclick: () => onGenerate(false) }, buttonContent(genBtn.running, state.busy, "Soạn tin trả lời")),
      el("button", { className: "button-secondary private-button", disabled: noteBtn.disabled, onclick: () => onHandoff(false) }, buttonContent(noteBtn.running, "Đang viết private note…", "🔒  Private note")),
      el("button", { className: "button-secondary knowledge-button", textContent: "Hỏi tài liệu", onclick: () => ((state.knowledgeOpen = !state.knowledgeOpen), render()) }),
    ]),
    knowledgePanel(handlers),
    state.busy ? el("div", { className: "loading-card" }, [
      el("p", { className: "muted", textContent: state.busy }),
      el("div", { className: "skeleton" }, [el("i"), el("i"), el("i")]),
    ]) : null,
    state.notice ? el("div", { className: `notice-card ${state.notice.startsWith("Đã") ? "success-notice" : ""}`, textContent: state.notice }) : null,
    state.choice ? el("div", { className: "insert-choice" }, [
      el("p", { className: "success-line", textContent: "Ô Reply đang có chữ: thay thế, chèn xuống cuối hay huỷ?" }),
      el("div", { className: "row" }, [
        el("button", { className: "button-primary", textContent: "Thay thế", disabled: state.insertPending, onclick: () => extension.sendInsert("replace") }),
        el("button", { className: "button-secondary", textContent: "Chèn xuống cuối", disabled: state.insertPending, onclick: () => extension.sendInsert("append") }),
        el("button", { className: "button-secondary", textContent: "Huỷ", onclick: () => ((state.choice = false), (state.notice = ""), render()) }),
      ]),
    ]) : null,
    draftPanel(handlers),
    jiraPanel(),
    el("section", { className: "meta-section" }, vm.metaRows.map((m) => el("div", { className: "meta-row" }, [
      el("span", { className: "muted", textContent: m.label }), el("span", { textContent: m.value }),
    ]))),
    handoffPanel(handlers),
    extensionHint(handlers),
    storefrontPanel(),
    csatPanel(handlers),
  );
}

// Cache check gần nhất theo session: quay lại conversation cũ là hiện ngay
// dữ liệu đã có, rồi mới gọi lại check để làm mới — khỏi chờ "Đang kiểm tra…".
const checkCache = new Map();

function applyCheck(sessionId) {
  if (state.check.sentiment) state.sentiment = state.check.sentiment;
  if (state.check.csat) state.csat = state.check.csat;
  if (state.check.latest_draft && !state.draft) {
    state.draft = { output_id: state.check.latest_draft.output_id, session_id: sessionId, vm: toDraftViewModel(state.check.latest_draft) };
  }
}

let loadInFlight = false;

async function load() {
  if (loadInFlight) return; // bấm Làm mới/Thử lại liên tục không gọi check song song
  loadInFlight = true;
  try {
    if (!state.operatorId) return showLoading("Đang xác định CS đang đăng nhập…");
    const sessionId = readContext(location.search).sessionId;
    if (sessionId !== state.shownSession) {
      state.shownSession = sessionId;
      state.draft = null;
      state.sentiment = null;
      state.sentimentMsgCount = 0;
      state.csat = null;
      state.csatError = false;
      state.handoff = null;
      state.knowledgeOpen = false;
      state.askQuestion = "";
      state.askResult = null;
      state.choice = false;
      state.draftPlacement = "";
      state.draftEditing = false;
      state.hint = "";
      state.notice = "";
      state.copiedKey = "";
      state.check = null;
      const cached = checkCache.get(sessionId);
      if (cached) {
        state.check = cached;
        applyCheck(sessionId);
        render();
      }
    }
    if (!state.check || state.shownSession !== sessionId) showLoading("Đang kiểm tra…");
    try {
      state.check = await call("check");
    } catch (e) {
      if (e.stale) return;
      if (checkCache.has(sessionId)) return; // đã hiện bản cache, lỗi làm mới thì giữ nguyên màn hình
      return showMessage(e.message ?? "Không kết nối được copilot", e.kind === "retry" || e.kind === "fatal");
    }
    if (readContext(location.search).sessionId !== sessionId) return; // CS đã chuyển conversation khác trong lúc chờ
    checkCache.set(sessionId, state.check);
    applyCheck(sessionId);
    render();
  } finally {
    loadInFlight = false;
  }
}

// CS đang đăng nhập lấy từ SDK chính thức của Crisp, không cần nhập token.
window.CRISP_READY_TRIGGER = () => {
  $crisp.onDataAcquired = (namespace) => {
    if (namespace !== "operator") return;
    state.operatorId = operatorIdFrom($crisp.data.operator);
    if (!state.operatorId) {
      console.warn("[copilot] operator data shape:", describeShape($crisp.data.operator));
      return showMessage(`Không đọc được CS đang đăng nhập. Crisp trả về: ${describeShape($crisp.data.operator)}`);
    }
    load();
  };
  $crisp.acquireData("operator");
};

const ctx = readContext(location.search);
if ("error" in ctx) showMessage(ctx.error);
else showLoading("Đang xác định CS đang đăng nhập…");
extension.detectExtension();
window.addEventListener("focus", () => {
  if (state.bridge !== "ready") extension.detectExtension();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.bridge !== "ready") extension.detectExtension();
});
