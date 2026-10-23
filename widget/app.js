import { actionButtonState, askAnswerToHint, describeShape, mapError, operatorIdFrom, operatorNameFrom, readContext, toAskViewModel, toDraftViewModel, toViewModel } from "./core.js";
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

const extension = createExtensionClient(render, setNotice);
function toggleSuggestion() {
  state.suggestionExpanded = !state.suggestionExpanded;
  render();
}

const handlers = { copy, onGenerate, onHandoff, onAnalyze, onSurvey, onAsk, onAskCompose, onAskRetry, onEditInCrisp, onToggleSuggestion: toggleSuggestion, sendInsert: extension.sendInsert, detectExtension: extension.detectExtension };

let noticeTimer = null;

/**
 * Hiện một thông báo trạng thái duy nhất, có hạn: thành công tự tắt sau 6s,
 * thông tin 8s, lỗi 12s; bấm × tắt ngay. Thông báo mới thay thông báo cũ —
 * không còn cảnh lỗi của thao tác trước treo lại khi CS đã làm việc khác.
 */
function setNotice(text, kind = "info") {
  state.notice = text;
  state.noticeKind = text ? kind : "";
  clearTimeout(noticeTimer);
  if (!text) return;
  const mine = text;
  noticeTimer = setTimeout(() => {
    if (state.notice === mine) {
      state.notice = "";
      state.noticeKind = "";
      render();
    }
  }, kind === "error" ? 12000 : kind === "success" ? 6000 : 8000);
}

function clearNotice() {
  clearTimeout(noticeTimer);
  state.notice = "";
  state.noticeKind = "";
}

/**
 * Sửa draft ngay trong Crisp: draft được điền vào ô Reply (extension tự focus
 * vào ô soạn khi điền) và CS sửa trực tiếp ở đó — panel không giữ bản sửa riêng.
 * Đã điền rồi thì không điền lại (tránh ghi đè phần CS vừa sửa), chỉ nhắc chỗ sửa.
 */
function onEditInCrisp() {
  if (!state.draft) return;
  if (state.draftPlacement === "inserted") {
    setNotice("Draft đang nằm trong ô Reply của Crisp — bấm vào ô Reply để sửa trực tiếp ở đó.", "info");
    render();
    return;
  }
  extension.sendInsert("replace");
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
  setNotice("Đã copy, dán vào ô Reply bằng Ctrl+V", "success");
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

async function call(action, extra = {}, signal) {
  const ctx = readContext(location.search);
  if ("error" in ctx) throw { message: ctx.error };
  const payload = { website_id: ctx.websiteId, session_id: ctx.sessionId, crisp_token: ctx.crispToken, operator_id: state.operatorId, action, ...extra };
  // Tên account đi kèm để server lấy tên trong draft theo đúng account đang
  // đăng nhập (DB chỉ là dự phòng khi SDK không trả tên).
  if (state.operatorName) payload.operator_name = state.operatorName;
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  }).catch((err) => {
    if (signal?.aborted) throw { aborted: true };
    return null;
  });
  const body = res ? await res.json().catch(() => ({})) : {};
  // Response về khi CS đã chuyển sang chat khác thì bỏ (spec 6.4 #2).
  if (readContext(location.search).sessionId !== ctx.sessionId) throw { stale: true };
  if (!res || !res.ok) throw mapError(res ? res.status : 0, body);
  return body;
}

// ---------- thẻ tiến trình (kiểu simulator) ----------

const PROGRESS_STEPS = {
  generate: ["Đọc hội thoại", "Đối chiếu bài helpdesk", "Soạn theo giọng của bạn", "Kiểm tra lại nội dung"],
  analyze: ["Đọc tin nhắn của khách", "Phân tích tâm trạng"],
  ask: ["Tìm trong tài liệu", "Đọc bài liên quan", "Soạn câu trả lời kèm nguồn"],
  handoff: ["Đọc hội thoại", "Viết private note"],
};
// Mốc thời gian (ms) chuyển sang bước kế — nhịp hiển thị để CS thấy việc đang
// chạy tới đâu; bước cuối giữ nguyên cho tới khi server trả kết quả thật.
const PROGRESS_MARKS = [0, 900, 2200, 4200];

let progressTimer = null;

function progressStepIndex(action, elapsedMs) {
  const steps = PROGRESS_STEPS[action] ?? [];
  let idx = 0;
  while (idx < steps.length - 1 && elapsedMs >= (PROGRESS_MARKS[idx + 1] ?? Number.POSITIVE_INFINITY)) idx++;
  return idx;
}

function startProgress(action) {
  stopProgress();
  state.progress = { action, startedAt: Date.now() };
  // Chỉ cập nhật đúng thẻ tiến trình trong DOM — render lại toàn panel nhiều
  // lần mỗi giây sẽ làm CS mất dấu con trỏ khi đang gõ ở ô ý/câu hỏi.
  progressTimer = setInterval(tickProgress, 200);
}

function stopProgress() {
  clearInterval(progressTimer);
  progressTimer = null;
  state.progress = null;
  state.abortController = null;
}

function tickProgress() {
  const p = state.progress;
  const card = document.querySelector(".prog");
  if (!p || !card) return;
  const steps = PROGRESS_STEPS[p.action] ?? [];
  const elapsed = Date.now() - p.startedAt;
  const idx = progressStepIndex(p.action, elapsed);
  const elapsedEl = card.querySelector(".prog-elapsed");
  if (elapsedEl) elapsedEl.textContent = `${(elapsed / 1000).toFixed(1)}s`;
  const bar = card.querySelector(".prog-bar i");
  if (bar) bar.style.width = `${Math.min(96, ((idx + 1) / Math.max(steps.length, 1)) * 100)}%`;
  card.querySelectorAll(".prog-steps li").forEach((li, i) => {
    li.classList.toggle("done", i < idx);
    li.classList.toggle("active", i === idx);
  });
}

function progressCard() {
  const p = state.progress;
  if (!p) return null;
  const steps = PROGRESS_STEPS[p.action] ?? [];
  const elapsed = Date.now() - p.startedAt;
  const idx = progressStepIndex(p.action, elapsed);
  return el("div", { className: "prog" }, [
    el("div", { className: "prog-head" }, [
      el("span", { className: "prog-spark", textContent: "✦" }),
      el("b", { textContent: state.busy }),
      el("span", { className: "prog-elapsed", textContent: `${(elapsed / 1000).toFixed(1)}s` }),
      state.abortController
        ? el("button", { className: "button-secondary compact-button", textContent: "Huỷ", onclick: () => state.abortController?.abort() })
        : null,
    ]),
    el("div", { className: "prog-bar" }, [el("i")]),
    el("ul", { className: "prog-steps" }, steps.map((s, i) =>
      el("li", { className: i < idx ? "done" : i === idx ? "active" : "" }, [
        el("span", { className: "prog-ic" }),
        document.createTextNode(s),
      ]))),
  ]);
}

async function onGenerate(force) {
  if (state.busy) return; // một action API tại một thời điểm — chặn cả Enter/bấm đúp lọt qua nút đã khoá
  state.busyAction = "generate";
  state.busy = force ? "Đang soạn lại…" : "Đang soạn…";
  clearNotice();
  state.choice = false;
  const ctrl = new AbortController();
  state.abortController = ctrl;
  startProgress("generate");
  render();
  try {
    const sessionId = readContext(location.search).sessionId;
    const extra = {};
    if (force) extra.force = true;
    const hint = state.hint.trim();
    if (hint) extra.hint = hint;
    if (state.tone !== "default") extra.tone = state.tone;
    const out = await call("generate", extra, ctrl.signal);
    state.draft = { output_id: out.output_id, session_id: sessionId, vm: toDraftViewModel(out) };
    if (out.sentiment) state.sentiment = out.sentiment;
    state.draftPlacement = "";
    state.busy = "";
    state.busyAction = "";
    stopProgress();
    render();
    if (state.bridge === "ready") extension.sendInsert("auto");
  } catch (e) {
    state.busy = "";
    state.busyAction = "";
    stopProgress();
    if (e?.aborted) setNotice("Đã huỷ soạn.", "info");
    else if (!e.stale) setNotice(e.message ?? "Không soạn được, thử lại sau", "error");
    render();
  }
}

async function onAnalyze(force) {
  if (state.busy) return;
  state.busyAction = "analyze";
  state.busy = "Đang phân tích tâm trạng…";
  clearNotice();
  const ctrl = new AbortController();
  state.abortController = ctrl;
  startProgress("analyze");
  render();
  try {
    const out = await call("analyze", force ? { force: true } : {}, ctrl.signal);
    state.sentiment = out.sentiment;
    if (typeof out.msg_count === "number") state.sentimentMsgCount = out.msg_count;
    if (!out.sentiment) {
      // Nói đúng nguyên nhân: server trả reason — đừng đổ hết về "chưa đủ tin nhắn"
      // khi thật ra AI cho sentiment chưa sẵn sàng (thiếu cấu hình/hết quota).
      if (out.reason === "ai_unavailable") {
        setNotice("Chưa phân tích được: AI cho sentiment chưa sẵn sàng trên server (thiếu cấu hình hoặc hết quota).", "error");
      } else {
        setNotice("Chưa đủ tin nhắn của khách để phân tích.", "info");
      }
    }
  } catch (e) {
    if (e?.aborted) setNotice("Đã huỷ phân tích.", "info");
    else if (!e.stale) setNotice(e.message ?? "Không phân tích được, thử lại sau", "error");
  }
  state.busy = "";
  state.busyAction = "";
  stopProgress();
  render();
}

async function onSurvey() {
  if (state.busy) return;
  state.busyAction = "survey";
  state.busy = "Đang gửi survey…";
  clearNotice();
  state.csatError = false;
  state.csatErrorMsg = "";
  render();
  try {
    const out = await call("survey");
    if (out.sent) {
      state.csat = { sent: true, sent_at: out.sent_at };
      state.csatError = false;
      setNotice(out.already ? "Survey đã được gửi trước đó rồi." : "Đã gửi CSAT survey cho khách.", "success");
    } else {
      // Panel CSAT hiện trạng thái lỗi riêng kèm nút Thử lại (board 5),
      // kèm đúng lý do server trả về thay vì một câu chung chung.
      state.csatError = true;
      state.csatErrorMsg = out.error ?? "";
    }
  } catch (e) {
    if (!e.stale) {
      state.csatError = true;
      state.csatErrorMsg = e.message ?? "";
    }
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
    setNotice("Hãy nhập câu hỏi để tìm trong tài liệu.", "info");
    render();
    return;
  }
  state.busyAction = "ask";
  state.busy = "Đang tìm tài liệu…";
  clearNotice();
  const ctrl = new AbortController();
  state.abortController = ctrl;
  startProgress("ask");
  render();
  try {
    const out = await call("ask", { question }, ctrl.signal);
    state.askResult = { question, ...toAskViewModel(out) };
  } catch (e) {
    if (e?.aborted) setNotice("Đã huỷ tìm tài liệu.", "info");
    else if (!e.stale) setNotice(e.message ?? "Không tìm được tài liệu, thử lại sau", "error");
  }
  state.busy = "";
  state.busyAction = "";
  stopProgress();
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
  clearNotice();
  const ctrl = new AbortController();
  state.abortController = ctrl;
  startProgress("handoff");
  render();
  try {
    const out = await call("handoff", force ? { force: true } : {}, ctrl.signal);
    state.handoff = { note: out.note, posted: out.posted, cached: out.cached };
    state.busy = "";
    state.busyAction = "";
    stopProgress();
    render();
  } catch (e) {
    state.busy = "";
    state.busyAction = "";
    stopProgress();
    if (e?.aborted) setNotice("Đã huỷ viết note.", "info");
    else if (!e.stale) setNotice(e.message ?? "Không tạo được handoff, thử lại sau", "error");
    render();
  }
}

// ---------- render ----------

const TONE_OPTIONS = [
  ["default", "Mặc định"],
  ["friendly", "Thân thiện"],
  ["formal", "Trang trọng"],
  ["concise", "Ngắn gọn"],
];

function render() {
  if (!state.check) return;
  const vm = toViewModel(state.check, Date.now());
  const genBtn = actionButtonState(state.busyAction, "generate");
  const noteBtn = actionButtonState(state.busyAction, "handoff");
  // Điều khiển soạn draft nằm TRƯỚC nút soạn: CS chọn ý + giọng văn trước,
  // draft sinh ra mới theo đúng lựa chọn — không còn cảnh soạn xong mới thấy chỗ chọn.
  const toneSelect = el("select", {
    className: "tone-select",
    title: "Giọng văn cho draft",
    onchange: (e) => { state.tone = e.target.value; },
  }, TONE_OPTIONS.map(([v, label]) => el("option", { value: v, textContent: label })));
  toneSelect.value = state.tone;
  const hintBox = el("textarea", {
    className: "field draft-hint",
    rows: 2,
    placeholder: "vd: lỗi 502, chờ dev, mai trả lời",
    value: state.hint,
    oninput: (e) => { state.hint = e.target.value; },
  });
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
    (vm.pendingMessages.length || state.draft) ? el("section", { className: "card compose-card" }, [
      el("p", { className: "muted", textContent: "Thêm ý của bạn (không bắt buộc). Để trống thì AI tự soạn từ tin khách; có ý thì ý của bạn được ưu tiên." }),
      hintBox,
      el("div", { className: "row draft-actions" }, [
        toneSelect,
        el("button", { className: "button-primary compose-button", disabled: genBtn.disabled, onclick: () => onGenerate(Boolean(state.draft)) }, buttonContent(genBtn.running, state.busy, state.draft ? "Soạn lại tin trả lời" : "Soạn tin trả lời")),
      ]),
    ]) : null,
    el("div", { className: "actions" }, [
      el("button", { className: "button-secondary private-button", disabled: noteBtn.disabled, onclick: () => onHandoff(false) }, buttonContent(noteBtn.running, "Đang viết private note…", "Private note")),
      el("button", { className: "button-secondary knowledge-button", textContent: "Knowledge Base Asking", onclick: () => ((state.knowledgeOpen = !state.knowledgeOpen), render()) }),
    ]),
    knowledgePanel(handlers),
    state.progress ? progressCard() : state.busy ? el("div", { className: "loading-card" }, [
      el("p", { className: "muted", textContent: state.busy }),
      el("div", { className: "skeleton" }, [el("i"), el("i"), el("i")]),
    ]) : null,
    state.notice ? el("div", { className: `notice-card ${state.noticeKind === "success" ? "success-notice" : ""} ${state.noticeKind === "error" ? "error-notice" : ""}` }, [
      el("span", { textContent: state.notice }),
      el("button", { className: "notice-close", textContent: "×", title: "Đóng thông báo", onclick: () => (clearNotice(), render()) }),
    ]) : null,
    state.choice ? el("div", { className: "insert-choice" }, [
      el("p", { className: "success-line", textContent: "Ô Reply đang có chữ: thay thế, chèn xuống cuối hay huỷ?" }),
      el("div", { className: "row" }, [
        el("button", { className: "button-primary", textContent: "Thay thế", disabled: state.insertPending, onclick: () => extension.sendInsert("replace") }),
        el("button", { className: "button-secondary", textContent: "Chèn xuống cuối", disabled: state.insertPending, onclick: () => extension.sendInsert("append") }),
        el("button", { className: "button-secondary", textContent: "Huỷ", onclick: () => ((state.choice = false), clearNotice(), render()) }),
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
      stopProgress();
      state.draft = null;
      state.sentiment = null;
      state.sentimentMsgCount = 0;
      state.csat = null;
      state.csatError = false;
      state.csatErrorMsg = "";
      state.handoff = null;
      state.knowledgeOpen = false;
      state.askQuestion = "";
      state.askResult = null;
      state.choice = false;
      state.draftPlacement = "";
      state.hint = "";
      clearNotice();
      state.copiedKey = "";
      state.suggestionExpanded = false;
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
    state.operatorName = operatorNameFrom($crisp.data.operator);
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
