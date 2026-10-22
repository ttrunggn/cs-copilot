import { describeShape, mapError, operatorIdFrom, readContext, toDraftViewModel, toViewModel } from "./core.js";
import { el, show } from "./dom.js";
import { state } from "./state.js";
import { createExtensionClient } from "./extension-client.js";
import { csatPanel, draftPanel, extensionHint, handoffPanel, insightPanel, jiraPanel, knowledgePanel, pendingMessageCard, suggestionCard, techPanel } from "./panels.js";

// Điều phối của widget: gọi API copilot, giữ luồng render/load và khởi động.
// Trạng thái nằm ở state.js, giao tiếp extension ở extension-client.js,
// các panel hiển thị ở panels.js, helper DOM ở dom.js.
const API = "https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot";
const requestedTheme = new URLSearchParams(location.search).get("theme");
if (requestedTheme === "light" || requestedTheme === "dark") document.documentElement.dataset.theme = requestedTheme;

const extension = createExtensionClient(render);
const handlers = { copy, onGenerate, onHandoff, onAnalyze, onSurvey, sendInsert: extension.sendInsert, detectExtension: extension.detectExtension };

function showMessage(text, retry) {
  show(el("section", { className: "state-card" }, [
    el("p", { className: "state-title", textContent: text }),
    retry ? el("button", { className: "button-secondary", textContent: "Thử lại", onclick: load }) : null,
  ]));
}

async function copy(text) {
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
  state.busy = force ? "Đang soạn lại…" : "Đang soạn…";
  state.notice = "";
  state.choice = false;
  render();
  try {
    const sessionId = readContext(location.search).sessionId;
    const out = await call("generate", force ? { force: true } : {});
    state.draft = { output_id: out.output_id, session_id: sessionId, vm: toDraftViewModel(out) };
    if (out.sentiment) state.sentiment = out.sentiment;
    state.draftPlacement = "";
    state.busy = "";
    render();
    if (state.bridge === "ready") extension.sendInsert("auto");
  } catch (e) {
    state.busy = "";
    if (!e.stale) state.notice = e.message ?? "Không soạn được, thử lại sau";
    render();
  }
}

async function onAnalyze(force) {
  state.busy = "Đang phân tích tâm trạng…";
  state.notice = "";
  render();
  try {
    const out = await call("analyze", force ? { force: true } : {});
    state.sentiment = out.sentiment;
    if (!out.sentiment) state.notice = "Chưa đủ tin nhắn của khách để phân tích.";
  } catch (e) {
    if (!e.stale) state.notice = e.message ?? "Không phân tích được, thử lại sau";
  }
  state.busy = "";
  render();
}

async function onSurvey() {
  state.busy = "Đang gửi survey…";
  state.notice = "";
  render();
  try {
    const out = await call("survey");
    if (out.sent) {
      state.csat = { sent: true, sent_at: out.sent_at };
      state.notice = out.already ? "Survey đã được gửi trước đó rồi." : "Đã gửi CSAT survey cho khách.";
    } else {
      state.notice = "Không gửi được survey (n8n gate không phản hồi), thử lại sau.";
    }
  } catch (e) {
    if (!e.stale) state.notice = e.message ?? "Không gửi được survey, thử lại sau";
  }
  state.busy = "";
  render();
}

async function onHandoff(force) {
  state.busy = "Đang viết handoff…";
  state.notice = "";
  render();
  try {
    const out = await call("handoff", force ? { force: true } : {});
    state.handoff = { note: out.note, posted: out.posted, cached: out.cached };
    state.busy = "";
    render();
  } catch (e) {
    state.busy = "";
    if (!e.stale) state.notice = e.message ?? "Không tạo được handoff, thử lại sau";
    render();
  }
}

// ---------- render ----------

function render() {
  if (!state.check) return;
  const vm = toViewModel(state.check, Date.now());
  const disabled = Boolean(state.busy);
  show(
    el("header", { className: "inbox-header" }, [
      el("div", {}, [el("h1", { textContent: vm.header }), el("p", { className: "subtitle", textContent: vm.subtitle })]),
      el("button", { className: "refresh-button", textContent: "↻", title: "Làm mới", onclick: load }),
    ]),
    vm.stale ? el("p", { className: "stale-line", textContent: "Dữ liệu có thể chậm vài phút" }) : null,
    insightPanel(handlers),
    !state.draft && vm.pendingMessages.length ? suggestionCard(handlers, vm.pendingMessages[vm.pendingMessages.length - 1].text) : null,
    vm.pendingMessages.length ? el("section", { className: "pending-section" }, [
      ...vm.pendingMessages.map(pendingMessageCard),
      vm.hiddenPendingCount ? el("p", { className: "muted", textContent: `Đang hiện ${vm.pendingMessages.length} trong ${vm.pendingCount} tin` }) : null,
    ]) : el("div", { className: "empty-state" }, [
      el("h2", { textContent: "Hết tin chờ rồi" }),
      el("p", { className: "subtitle", textContent: vm.subtitle }),
    ]),
    el("div", { className: "actions" }, [
      el("button", { className: "button-primary compose-button", textContent: state.busy.startsWith("Đang soạn") ? "Đang soạn…" : "Soạn tin trả lời", disabled, onclick: () => onGenerate(false) }),
      el("button", { className: "button-secondary private-button", textContent: state.busy.startsWith("Đang viết") ? "Đang viết private note…" : "🔒  Private note", disabled, onclick: () => onHandoff(false) }),
      el("button", { className: "button-secondary knowledge-button", textContent: "Hỏi tài liệu", onclick: () => ((state.knowledgeOpen = !state.knowledgeOpen), render()) }),
    ]),
    knowledgePanel(),
    state.busy ? el("div", { className: "loading-card" }, [
      el("p", { className: "muted", textContent: state.busy }),
      el("div", { className: "skeleton" }, [el("i"), el("i"), el("i")]),
    ]) : null,
    state.notice ? el("div", { className: `notice-card ${state.notice.startsWith("Đã") ? "success-notice" : ""}`, textContent: state.notice }) : null,
    state.choice ? el("div", { className: "insert-choice" }, [
      el("p", { className: "success-line", textContent: "Ô Reply đang có chữ: thay thế, chèn xuống cuối hay huỷ?" }),
      el("div", { className: "row" }, [
        el("button", { className: "button-primary", textContent: "Thay thế", onclick: () => extension.sendInsert("replace") }),
        el("button", { className: "button-secondary", textContent: "Chèn xuống cuối", onclick: () => extension.sendInsert("append") }),
        el("button", { className: "button-secondary", textContent: "Huỷ", onclick: () => ((state.choice = false), (state.notice = ""), render()) }),
      ]),
    ]) : null,
    el("section", { className: "meta-section" }, vm.metaRows.map((m) => el("div", { className: "meta-row" }, [
      el("span", { className: "muted", textContent: m.label }), el("span", { textContent: m.value }),
    ]))),
    jiraPanel(),
    handoffPanel(handlers),
    techPanel(),
    draftPanel(handlers),
    extensionHint(handlers),
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

async function load() {
  if (!state.operatorId) return showMessage("Đang xác định CS đang đăng nhập…");
  const sessionId = readContext(location.search).sessionId;
  if (sessionId !== state.shownSession) {
    state.shownSession = sessionId;
    state.draft = null;
    state.sentiment = null;
    state.csat = null;
    state.handoff = null;
    state.knowledgeOpen = false;
    state.choice = false;
    state.draftPlacement = "";
    state.notice = "";
    state.check = null;
    const cached = checkCache.get(sessionId);
    if (cached) {
      state.check = cached;
      applyCheck(sessionId);
      render();
    }
  }
  if (!state.check || state.shownSession !== sessionId) showMessage("Đang kiểm tra…");
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
else showMessage("Đang xác định CS đang đăng nhập…");
extension.detectExtension();
window.addEventListener("focus", () => {
  if (state.bridge !== "ready") extension.detectExtension();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.bridge !== "ready") extension.detectExtension();
});
