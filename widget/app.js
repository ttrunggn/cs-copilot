import { askAnswerToHint, countPlaceholders, describeShape, enabledModules, explanationTemplate, mapError, monitorModalUrl, monitorRelayPayload, sessionFromRelayPayload, openModalName, operatorIdFrom, operatorNameFrom, apiUrlFor, parseFnParam, parseOpenParam, standaloneViewFor, PROGRESS_STEPS, progressStepIndex, readContext, REVIEW_TEMPLATE, toAskViewModel, toDraftViewModel, toViewModel } from "./core.js";
import { el, show } from "./dom.js";
import { resetSessionScopedState, state } from "./state.js";
import { createExtensionClient } from "./extension-client.js";
import { commandsRow, extensionHint, insightPanel, issuesPanel, jiraPanel, modalView, storefrontPanel } from "./panels.js";

// Điều phối của widget: gọi API copilot, giữ luồng render/load và khởi động.
// Trạng thái nằm ở state.js, giao tiếp extension ở extension-client.js,
// các panel hiển thị ở panels.js, helper DOM ở dom.js.
// Function đích: production `copilot`; modal mở từ mặt native bản test
// mang fn=copilot-test thì mọi lời gọi đi vào function test (parseFnParam
// ở core.js — giá trị lạ rơi về production).
const API = apiUrlFor(parseFnParam(location.search));
// Chế độ standalone: trang mở từ nút modal của mặt native (?open=) — chỉ
// render đúng view được yêu cầu thay vì cả panel (xem render()).
const standaloneView = standaloneViewFor(parseOpenParam(location.search));
if (standaloneView) document.body?.classList.add("standalone");
const requestedTheme = new URLSearchParams(location.search).get("theme");
if (requestedTheme === "light" || requestedTheme === "dark") document.documentElement.dataset.theme = requestedTheme;

const extension = createExtensionClient(render, setNotice);

/** Mở popup của một lệnh (draft | note | ask | csat) — panel gọn v4. */
function openModal(name) {
  state.modal = name;
  if (name === "draft") state.composeOpen = !state.draft;
  if (name === "csat") {
    state.csatChoice = "";
    if (!state.reviewText) state.reviewText = state.check?.review_template?.text ?? REVIEW_TEMPLATE;
  }
  render();
}

function closeModal() {
  // Standalone: view gốc chính là cả trang — đóng nó chỉ còn trang trắng
  // (đóng hẳn modal Crisp đã có nút riêng của Crisp ở dưới modal).
  if (standaloneView && state.modal === standaloneView) return;
  state.modal = null;
  render();
}

/**
 * Hỏi cách điền khi ô soạn đang có chữ (extension trả not_empty): dùng cho
 * draft, tin xin review, mẫu giải thích (ô Reply) lẫn private note (ô Note)
 * — nút gửi đi theo state.choiceFor. Hiện trong popup đang mở (panels.js gọi qua handlers)
 * hoặc ngay trên panel khi không có popup.
 */
function insertChoiceNode() {
  if (!state.choice) return null;
  const send = state.choiceFor === "review" ? extension.sendReviewInsert : state.choiceFor === "note" ? extension.sendNoteInsert : state.choiceFor === "explain" ? extension.sendExplainInsert : extension.sendInsert;
  const box = state.choiceFor === "note" ? "Ô Note" : "Ô Reply";
  return el("div", { className: "insert-choice" }, [
    el("p", { className: "success-line", textContent: `${box} đang có chữ. Thay thế sẽ xoá toàn bộ nội dung hiện có.` }),
    el("div", { className: "row" }, [
      el("button", { className: "button-primary", textContent: "Thay thế toàn bộ", disabled: state.insertPending, onclick: () => send("replace") }),
      el("button", { className: "button-secondary", textContent: "Huỷ", onclick: () => ((state.choice = false), clearNotice(), render()) }),
    ]),
  ]);
}

const handlers = { onGenerate, onHandoff, onAnalyze, onSurvey, onAsk, onAskCompose, onAskRetry, onEditInCrisp, onInsertNote, onJiraSync, onJiraUnlink, onStorefrontLoad, onStorefrontFinding, onStorefrontMenu, onStorefrontForm, onStorefrontAct, onExplain, onSuggTry, onSuggOrig, onSuggAdopt, onSuggSave, sendInsert: extension.sendInsert, sendReviewInsert: extension.sendReviewInsert, sendNoteInsert: extension.sendNoteInsert, sendExplainInsert: extension.sendExplainInsert, detectExtension: extension.detectExtension, onOpenModal: openModal, onCloseModal: closeModal, progressCard, insertChoice: insertChoiceNode, rerender: render };

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

/**
 * Điền private note vào ô Note của Crisp (nút chính trong popup Private
 * note): chưa điền thì gửi lệnh insert "auto" (extension tự chuyển sang tab
 * Note, chỉ điền khi xác nhận được Note mode; ô Note có chữ thì panel hỏi
 * cách điền). Đã điền rồi thì không điền lại — tránh ghi đè phần CS vừa
 * sửa — chỉ nhắc sang ô Note để sửa và tự đăng ở đó.
 */
function onInsertNote() {
  if (!state.handoff) return;
  if (state.notePlacement === "inserted") {
    setNotice("Note đang nằm trong ô Note của Crisp — bấm vào tab Note để sửa trực tiếp và tự đăng ở đó.", "info");
    render();
    return;
  }
  extension.sendNoteInsert("auto");
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



// ---------- API ----------

// Các action KHÔNG có nút Huỷ riêng (check, survey, jira_sync, jira_unlink,
// storefront, storefront_finding) bị giới hạn bởi timeout này: fetch treo
// (mạng rớt lặng, gateway không trả lời) không được phép để spinner quay mãi.
// 4 action AI có AbortController riêng (nút Huỷ trên thẻ tiến trình) thì giữ
// nguyên signal của caller — soạn AI chạy lâu là bình thường, CS tự huỷ.
const CALL_TIMEOUT_MS = 20000;

async function call(action, extra = {}, signal) {
  const ctx = readContext(location.search);
  if ("error" in ctx) throw { message: ctx.error };
  const payload = { website_id: ctx.websiteId, session_id: ctx.sessionId, crisp_token: ctx.crispToken, operator_id: state.operatorId, action, ...extra };
  // Tên account đi kèm để server lấy tên trong draft theo đúng account đang
  // đăng nhập (DB chỉ là dự phòng khi SDK không trả tên).
  if (state.operatorName) payload.operator_name = state.operatorName;
  let timedOut = false;
  let timer = null;
  if (!signal) {
    const ctrl = new AbortController();
    signal = ctrl.signal;
    timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, CALL_TIMEOUT_MS);
  }
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    }).catch((err) => {
      if (signal?.aborted) throw timedOut ? { kind: "retry", message: "Hết thời gian chờ phản hồi, thử lại" } : { aborted: true };
      return null;
    });
    const body = res ? await res.json().catch(() => ({})) : {};
    // Response về khi CS đã chuyển sang chat khác thì bỏ (spec 6.4 #2).
    if (readContext(location.search).sessionId !== ctx.sessionId) throw { stale: true };
    if (!res || !res.ok) throw mapError(res ? res.status : 0, body);
    return body;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- thẻ tiến trình (kiểu simulator) ----------
// Bảng bước + mốc thời gian + progressStepIndex nằm ở core.js (logic thuần, có test).

let progressTimer = null;

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
    state.draftSugg = out.draft_suggestion ?? null;
    state.draftSuggPhase = "";
    state.draftSuggOrig = "";
    if (out.sentiment) state.sentiment = out.sentiment;
    state.composeOpen = false; // soạn xong thì popup Draft thu form, chỉ còn draft + nút điền
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

/* Thẻ gợi ý tối ưu (preview v8 Ethan duyệt): Thử → Dùng bản gợi ý / Dùng
 * bản gốc → Lưu làm mẫu mới (chỉ sau khi đã dùng bản gợi ý). Áp cho cả
 * Draft (gợi ý runtime từ generate) và Review (gợi ý lưu trong profile). */
function onSuggTry(kind) {
  if (kind === "draft") {
    if (!state.draft || !state.draftSugg) return;
    state.draftSuggOrig = state.draft.vm.text;
    state.draft.vm.text = state.draftSugg.text;
    state.draft.vm.todos = countPlaceholders(state.draftSugg.text);
    state.draftPlacement = "";
    state.draftSuggPhase = "trying";
  } else {
    const t = state.check?.review_template;
    if (!t?.suggestion) return;
    state.reviewSuggOrig = state.reviewText || t.text;
    state.reviewText = t.suggestion.text;
    state.reviewInsertId = "";
    state.reviewSuggPhase = "trying";
  }
  render();
}

function onSuggOrig(kind) {
  if (kind === "draft") {
    if (!state.draft) return;
    state.draft.vm.text = state.draftSuggOrig;
    state.draft.vm.todos = countPlaceholders(state.draftSuggOrig);
    state.draftSuggPhase = "";
  } else {
    state.reviewText = state.reviewSuggOrig;
    state.reviewInsertId = "";
    state.reviewSuggPhase = "";
  }
  render();
}

function onSuggAdopt(kind) {
  if (kind === "draft") state.draftSuggPhase = "adopted";
  else state.reviewSuggPhase = "adopted";
  render();
}

async function onSuggSave(kind) {
  const text = kind === "draft" ? state.draft?.vm.text : state.reviewText;
  if (!text?.trim()) return;
  try {
    await call("save_suggestion", { suggestion_kind: kind, suggestion_text: text });
    if (kind === "draft") {
      state.draftSuggPhase = "saved";
    } else {
      state.reviewSuggPhase = "saved";
      // Mẫu mới đã là template chính thức: cập nhật ngay để thẻ biến mất và
      // khối profile hiện đúng, khỏi chờ check lại.
      if (state.check?.review_template) {
        state.check.review_template = { text, source: "profile", suggestion: null };
      }
    }
    setNotice("Đã lưu bản gợi ý làm mẫu mới của bạn.", "success");
  } catch (e) {
    setNotice(e.message ?? "Chưa lưu được mẫu, thử lại sau", "error");
  }
  render();
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
    if (out.sentiment) state.sentimentAt = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
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

/**
 * Compute-on-view (Lỗi 5): check báo sentiment đã lưu không còn khớp tin khách
 * hiện tại → tự gọi analyze NGẦM (không khoá panel bằng busy) để panel luôn
 * hiện phân tích mới nhất, không phụ thuộc precompute qua n8n. Chìa khoá
 * chống lặp: session + mốc tin khách cuối — cùng một trạng thái hội thoại
 * chỉ tự làm tươi một lần (AI lỗi cũng không bắn vòng lặp); khách nhắn thêm
 * (mốc đổi) thì được làm tươi lại.
 */
let autoRefreshKey = "";

async function maybeAutoRefreshSentiment(sessionId) {
  if (!state.check?.sentiment_stale || state.busy) return;
  const key = `${sessionId}|${state.check.last_customer_at ?? ""}`;
  if (autoRefreshKey === key) return;
  autoRefreshKey = key;
  state.sentimentRefreshing = true;
  render();
  try {
    const out = await call("analyze", {});
    if (readContext(location.search).sessionId !== sessionId) return; // đã chuyển chat khác
    if (out.sentiment) {
      state.sentiment = out.sentiment;
      state.sentimentAt = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      if (state.check) state.check.sentiment = out.sentiment;
    }
    if (typeof out.msg_count === "number") state.sentimentMsgCount = out.msg_count;
    if (state.check) state.check.sentiment_stale = false;
  } catch {
    // Lỗi thì giữ bản phân tích cũ đang hiện — im lặng, không báo lỗi chen
    // ngang; sentiment tự tính lại ở lần mở chat kế tiếp (compute-on-view),
    // panel không còn nút phân tích thủ công (Ethan bỏ 2026-10-29).
  }
  state.sentimentRefreshing = false;
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

/** Đáp án tài liệu → ý của CS trong popup Draft, rồi generate như bấm Soạn tin. */
function onAskCompose(answer) {
  state.hint = askAnswerToHint(answer);
  state.modal = "draft"; // tiến trình soạn + draft hiện ở popup Draft, không kẹt trong popup Ask
  state.composeOpen = true;
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
    state.handoff = { note: out.note, cached: out.cached };
    // Note mới (hoặc note khác) thì mốc "đã điền" phải reset: output_id tổng
    // hợp mới để extension không chặn duplicate, placement về chưa điền.
    state.noteInsertId = "";
    state.notePlacement = "";
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

/** Nút "Sync ngay" ở module Jira: server đồng bộ ngay trong request này,
 *  xong thì check lại để panel hiện dữ liệu mới. */
async function onJiraSync() {
  if (state.busy) return;
  state.busyAction = "jira_sync";
  state.busy = "Đang đồng bộ Jira…";
  clearNotice();
  render();
  try {
    const out = await call("jira_sync_now");
    if (out.triggered) {
      setNotice("Đã đồng bộ Jira.", "success");
      await load();
    } else {
      setNotice(out.error ?? "Không đồng bộ được Jira.", "error");
    }
  } catch (e) {
    if (!e.stale) setNotice(e.message ?? "Không đồng bộ được Jira, thử lại sau", "error");
  }
  state.busy = "";
  state.busyAction = "";
  render();
}

/** Nút "✕ Gỡ" trên một ticket: gọi action jira_unlink (server chỉ tắt link
 *  của đúng chat này), xong check lại ngay để ticket biến mất khỏi panel. */
async function onJiraUnlink(issueKey) {
  if (state.busy) return;
  state.busyAction = "jira_unlink";
  state.busy = "Đang gỡ liên kết…";
  clearNotice();
  render();
  try {
    const out = await call("jira_unlink", { issue_key: issueKey });
    state.unlinkConfirm = "";
    setNotice(out.removed ? `Đã gỡ ticket ${issueKey} khỏi panel.` : `Ticket ${issueKey} không còn được theo dõi trong chat này.`, "success");
    state.busy = "";
    state.busyAction = "";
    render();
    load();
    return;
  } catch (e) {
    if (!e.stale) setNotice(e.message ?? "Không gỡ được liên kết, thử lại sau", "error");
  }
  state.busy = "";
  state.busyAction = "";
  state.unlinkConfirm = "";
  render();
}

/**
 * Module Storefront Watch: nạp dữ liệu thật qua action `storefront` (server
 * gọi MCP Storefront Watch trực tiếp và tự chia 3 trạng thái). Shop được
 * resolve PHÍA SERVER: widget đã biết shop của chat này (CS nhập từ trước)
 * thì truyền lên; chưa biết thì gọi KHÔNG kèm shop — server tự lấy
 * `shopify_domain` từ custom data của phiên Crisp (ingest merge session data
 * vào conversations.custom_data). Server trả need_shop (phiên không có sẵn
 * shopify_domain) thì module mới hiện ô nhập tay làm fallback. Kết quả/lỗi
 * đều hiện trong module, không bịa dữ liệu.
 */
async function onStorefrontLoad() {
  if (state.busyAction === "storefront") return;
  const typed = (state.storefrontShopInput || state.storefrontShop || "").trim();
  state.busyAction = "storefront";
  // Đặt cả nhãn busy: các handler khác chặn song song bằng `if (state.busy)`
  // và actionButtonState đã khoá mọi nút theo busyAction — trước đây SF chỉ
  // đặt busyAction nên Enter trong ô hỏi/gõ phím vẫn lọt qua gọi API song song.
  state.busy = "Đang kiểm tra storefront…";
  state.storefront = { status: "loading" };
  state.storefrontDetail = null;
  // Nạp lại = lấy sự thật mới từ server: menu/form/đóng-cục-bộ của lượt trước bỏ hết.
  state.sfMenu = "";
  state.sfForm = null;
  state.sfNoteInput = "";
  state.sfReason = "";
  state.sfClosed = {};
  state.sfMsg = "";
  render();
  try {
    const out = await call("storefront", typed ? { shop: typed } : {});
    if (out.status === "need_shop") {
      state.storefront = { status: "need-shop" };
    } else if (out.status === "ok" || out.status === "not_watched") {
      if (out.store) {
        state.storefrontShop = out.store;
        state.storefrontShopInput = out.store;
      }
      state.storefront = {
        status: "ok",
        store: out.store,
        scannedAt: out.scanned_at,
        notWatched: out.status === "not_watched",
        new: out.groups?.new ?? [],
        acknowledged: out.groups?.acknowledged ?? [],
        inProgress: out.groups?.in_progress ?? [],
      };
    } else {
      state.storefront = { status: out.status === "unconfigured" ? "unconfigured" : "error", error: out.error ?? undefined };
    }
  } catch (e) {
    if (!e.stale) state.storefront = { status: "error", error: e.message ?? "Không gọi được Storefront Watch, thử lại sau" };
  }
  state.busyAction = "";
  state.busy = "";
  render();
}

/**
 * Bấm "Mẫu giải thích" ở một finding: dựng đoạn mẫu tĩnh theo loại lỗi của
 * finding đó (explanationTemplate ở core.js) rồi mở popup Mẫu giải thích —
 * trong popup CS bấm điền vào ô Reply qua extension như mọi draft (tự đọc/
 * sửa và tự gửi trong Crisp). Reset explainInsertId để lệnh điền của finding
 * này không bị chặn "duplicate" bởi lần điền của finding trước.
 */
function onExplain(finding) {
  state.explainFinding = finding;
  state.explainText = explanationTemplate(finding);
  state.explainInsertId = "";
  state.modal = "explain";
  render();
}

/** Bấm một finding trong module Storefront: mở chi tiết (get_finding) ngay dưới dòng đó; bấm lại = đóng. */
async function onStorefrontFinding(fingerprint) {
  if (!fingerprint || state.storefrontDetailLoading) return;
  if (state.storefrontDetail?.fingerprint === fingerprint) {
    state.storefrontDetail = null;
    render();
    return;
  }
  state.storefrontDetailLoading = fingerprint;
  render();
  try {
    const out = await call("storefront_finding", { fingerprint });
    state.storefrontDetail = out.status === "ok" && out.detail
      ? out.detail
      : { fingerprint, error: out.error ?? "Không tải được chi tiết finding" };
  } catch (e) {
    if (!e.stale) state.storefrontDetail = { fingerprint, error: e.message ?? "Không tải được chi tiết finding" };
  }
  state.storefrontDetailLoading = "";
  render();
}

/** Bấm một dòng finding: mở/đóng menu thao tác ngay dưới dòng đó (bản giả lập Ethan duyệt 2026-10-27). */
function onStorefrontMenu(fingerprint) {
  if (!fingerprint || state.sfActBusy) return;
  state.sfMenu = state.sfMenu === fingerprint ? "" : fingerprint;
  state.sfForm = null;
  state.sfNoteInput = "";
  state.sfReason = "";
  render();
  // Menu vừa mở phải nằm trong tầm mắt ngay (khỏi cuộn tìm): kéo nhẹ menu
  // vào view theo cạnh gần nhất, không nhảy trang.
  if (state.sfMenu) document.querySelector(".sf-menu")?.scrollIntoView?.({ block: "nearest" });
}

/** Mở form ghi chú Fixed/Dismiss trong menu của một finding; kind = null thì đóng form. */
function onStorefrontForm(fingerprint, kind) {
  state.sfForm = kind ? { fingerprint, kind } : null;
  state.sfNoteInput = "";
  state.sfReason = "";
  render();
}

/** Chuyển cục bộ một finding sang nhóm Đang xử lý sau khi acknowledge thành công (khỏi nạp lại cả thẻ). */
function moveSfItemToInProgress(fingerprint) {
  const sf = state.storefront;
  if (!sf) return;
  for (const key of ["new", "acknowledged"]) {
    const list = sf[key] ?? [];
    const i = list.findIndex((f) => f.fingerprint === fingerprint);
    if (i >= 0) {
      const [item] = list.splice(i, 1);
      sf.inProgress = [...(sf.inProgress ?? []), item];
      return;
    }
  }
}

const SF_ACT_MSG = {
  acknowledge: "Đã ghi nhận bạn đang xử lý lỗi này.",
  fixed: "Đã đánh dấu Fix.",
  dismiss: "Đã Dismiss lỗi này.",
  undo: "Đã mở lại lỗi.",
};

/**
 * Gửi thao tác ghi lên server (action storefront_act): acknowledge một chạm;
 * fixed/dismiss kèm ghi chú tuỳ chọn (Dismiss kèm lý do bắt buộc) lấy từ form trong menu; undo mở lại
 * finding vừa đóng trong phiên panel này. Thành công thì cập nhật cục bộ
 * ngay (chuyển nhóm / đánh dấu đã đóng / bỏ đánh dấu) + một dòng trạng thái;
 * lỗi thì hiện nguyên văn lỗi server trong cùng dòng trạng thái đó, form giữ
 * nguyên để CS sửa rồi gửi lại.
 */
async function onStorefrontAct(fingerprint, act) {
  if (!fingerprint || state.sfActBusy) return;
  const extra = { fingerprint, sf_act: act };
  if (act === "fixed" || act === "dismiss") {
    extra.note = state.sfNoteInput.trim();
    if (act === "dismiss") {
      extra.reason = state.sfReason;
      if (!extra.reason) {
        state.sfMsg = "Cần chọn lý do Dismiss.";
        render();
        return;
      }
    }
  }
  state.sfActBusy = fingerprint;
  render();
  try {
    const out = await call("storefront_act", extra);
    if (out.status === "ok") {
      if (act === "acknowledge") moveSfItemToInProgress(fingerprint);
      if (act === "fixed" || act === "dismiss") {
        state.sfClosed = { ...state.sfClosed, [fingerprint]: { via: act, note: extra.note } };
      }
      if (act === "undo") {
        const next = { ...state.sfClosed };
        delete next[fingerprint];
        state.sfClosed = next;
      }
      state.sfForm = null;
      state.sfNoteInput = "";
      state.sfReason = "";
      state.sfMsg = SF_ACT_MSG[act] ?? "Đã cập nhật.";
    } else {
      state.sfMsg = out.error ?? "Không thực hiện được, thử lại sau";
    }
  } catch (e) {
    if (!e.stale) state.sfMsg = e.message ?? "Không thực hiện được, thử lại sau";
  }
  state.sfActBusy = "";
  render();
}

// ---------- render ----------

/**
 * Panel gọn (preview v4 Ethan duyệt): mặc định chỉ xổ 3 module — Tâm trạng
 * khách, Vấn đề của khách, Issue logs (Storefront + Jira khi có) — rồi thông
 * báo, hàng lệnh, và popup của lệnh đang mở. Draft/note/ask/CSAT không còn
 * nằm thường trực trên panel; chúng sống trong popup (panels.js modalView).
 * Tiến trình/hỏi-cách-điền hiện trong popup khi có popup, ngược lại trên panel.
 */
/** Thẻ thông báo kết quả hành động — dùng cho cả panel và standalone. */
function noticeNode() {
  return state.notice ? el("div", { className: `notice-card ${state.noticeKind === "success" ? "success-notice" : ""} ${state.noticeKind === "error" ? "error-notice" : ""}` }, [
    el("span", { textContent: state.notice }),
    el("button", { className: "notice-close", textContent: "×", title: "Đóng thông báo", onclick: () => (clearNotice(), render()) }),
  ]) : null;
}

let lastRenderSession = null;
function render() {
  if (!state.check) return;
  // Giữ nguyên vị trí cuộn của panel qua mỗi lần render (render dựng lại
  // toàn bộ DOM nên mặc định nhảy về đầu — Ethan bắt live 2026-10-27 khi
  // bấm finding ở cuối danh sách). Đổi conversation thì không giữ.
  const sameSession = lastRenderSession === state.shownSession;
  const prevScrollY = sameSession && typeof window !== "undefined" ? window.scrollY : 0;
  lastRenderSession = state.shownSession;
  const vm = toViewModel(state.check, Date.now());
  // Standalone (trang mở từ nút modal của mặt native): chỉ render đúng
  // view — thân modal cho draft/note/ask/csat, card cho storefront/jira
  // (modal "explain" của Storefront vẫn mở chồng lên card) — kèm thẻ
  // thông báo. Không header, không hàng lệnh, không giữ vị trí cuộn.
  if (standaloneView) {
    const cardView = standaloneView === "storefront" || standaloneView === "jira" || standaloneView === "monitor" || standaloneView === "swmonitor";
    show(
      standaloneView === "storefront" || standaloneView === "monitor" || standaloneView === "swmonitor" ? storefrontPanel(handlers) : null,
      standaloneView === "jira" || standaloneView === "monitor" ? jiraPanel(handlers) : null,
      cardView ? null : modalView(handlers),
      noticeNode(),
      cardView ? modalView(handlers) : null,
    );
    return;
  }
  const modalOpen = Boolean(state.modal);
  show(
    el("header", { className: "inbox-header" }, [
      el("div", {}, [
        el("h1", { textContent: vm.header }),
        el("p", { className: "subtitle", textContent: vm.subtitle }),
        // Tên khách + shopify domain của họ ngay đầu panel (Ethan chốt
        // 2026-10-26). Domain ưu tiên bản check đã resolve; panel Storefront
        // nạp xong thì lấy store thật của nó.
        (vm.customerName || vm.shopDomain || state.storefront?.store)
          ? el("p", { className: "customer-line" }, [
            vm.customerName ? el("b", { textContent: vm.customerName }) : null,
            (vm.shopDomain ?? state.storefront?.store)
              ? el("span", { className: "muted", textContent: ` · ${vm.shopDomain ?? state.storefront?.store}` })
              : null,
          ])
          : null,
        // Dòng báo dữ liệu chậm nằm TRONG card đầu panel (Ethan, 2026-10-28):
        // trước đây nó nằm trơ dưới header trên nền tối nhất, lap của CS nhìn
        // tối và rời rạc — cả cụm đầu đã thành một card như các khối khác.
        vm.stale ? el("p", { className: "stale-line", textContent: "Dữ liệu có thể chậm vài phút" }) : null,
      ]),
      el("button", { className: "refresh-button", textContent: "↻", title: "Làm mới", onclick: load }),
    ]),
    insightPanel(handlers),
    issuesPanel(vm),
    storefrontPanel(handlers),
    jiraPanel(handlers),
    // Nút mở monitor nổi: phải mở bằng showModal TỪ panel thì relay
    // session (forwardEvent) mới tới được modal — xem khối Monitor.
    (enabledModules(state.check).storefront || enabledModules(state.check).jira)
      ? el("div", { className: "monitor-launch" }, [
          el("button", { className: "button-secondary monitor-launch-button", textContent: "Theo dõi Storefront + Jira", onclick: () => openMonitorModal() }),
        ])
      : null,
    extensionHint(handlers),
    state.progress && !modalOpen ? progressCard() : !modalOpen && state.busy ? el("div", { className: "loading-card" }, [
      el("p", { className: "muted", textContent: state.busy }),
      el("div", { className: "skeleton" }, [el("i"), el("i"), el("i")]),
    ]) : null,
    noticeNode(),
    !modalOpen ? insertChoiceNode() : null,
    commandsRow(handlers),
    modalView(handlers),
  );
  if (prevScrollY > 0) window.scrollTo(0, prevScrollY);
}

// Cache check gần nhất theo session: quay lại conversation cũ là hiện ngay
// dữ liệu đã có, rồi mới gọi lại check để làm mới — khỏi chờ "Đang kiểm tra…".
const checkCache = new Map();

function applyCheck(sessionId) {
  if (state.check.sentiment) state.sentiment = state.check.sentiment;
  if (state.check.csat) state.csat = state.check.csat;
  // Template xin review theo profile do server phân giải — nạp sẵn để popup
  // Review mở ra là có mẫu của chính CS; CS đã sửa tay trong phiên thì giữ
  // nguyên bản sửa, không ghi đè.
  if (state.check.review_template?.text && !state.reviewText) state.reviewText = state.check.review_template.text;
  if (state.check.latest_draft && !state.draft) {
    state.draft = { output_id: state.check.latest_draft.output_id, session_id: sessionId, vm: toDraftViewModel(state.check.latest_draft) };
    state.draftSugg = null;
    state.draftSuggPhase = "";
    state.draftSuggOrig = "";
  }
}

/**
 * Deep-link ?open= từ mặt native (Generic Widget): sau khi check đầu tiên
 * của session hoàn tất, mở thẳng modal tương ứng (draft/note/ask/review)
 * hoặc cuộn tới card inline (storefront/jira). Chỉ áp MỘT lần cho mỗi
 * session — các lần load() sau (refresh, nạp lại Jira…) không mở lại.
 * URL sidebar thường không có ?open= nên luồng cũ không đổi.
 */
let deepLinkDoneFor = "";
function applyOpenDeepLink(sessionId) {
  if (deepLinkDoneFor === sessionId) return;
  deepLinkDoneFor = sessionId;
  const open = parseOpenParam(location.search);
  if (!open) return;
  const name = openModalName(open);
  if (name) return openModal(name);
  const sel = open === "storefront" ? ".storefront-card" : ".jira-section";
  document.querySelector(sel)?.scrollIntoView({ block: "start" });
}

/**
 * Standalone: mở view gốc đúng MỘT lần sau check đầu tiên (openModal tự
 * render lại). Các load() sau (refresh, nạp lại Jira…) không mở lại —
 * view gốc không đóng được nên state.modal luôn còn nguyên.
 */
// ---------- Monitor (Storefront + Jira trong MỘT modal nổi) ----------
// Ethan chốt ý tưởng 30/10: modal thu nhỏ/di chuyển sống xuyên
// conversation, mở MỘT lần rồi tự bám theo chat đang mở. Đường SDK
// trong modal đã chết (đo live 30/10: dữ liệu conversation của SDK bị
// đóng băng theo chat lúc mở modal). Cơ chế chạy được là RELAY
// iframe + SDK (chứng minh live 02/11 bằng plugin probe riêng): panel
// iframe luôn biết conversation hiện tại (Crisp nạp lại panel theo
// từng chat), mỗi lần boot panel đẩy session sang modal bằng
// $crisp.forwardEvent; modal nghe $crisp.onEventForwarded rồi tự nạp
// lại theo session mới (giữ nguyên token và các param Crisp gắn).
// Relay chỉ chạy trong CÙNG một plugin — monitor phải do panel mở
// bằng $crisp.showModal (nút "Theo dõi Storefront + Jira" trên panel)
// mới nhận được; bản mở từ mặt native của plugin khác thì đứng yên
// như modal thường. Đang thao tác Storefront (gửi hành động / mở
// form) thì HOÃN nạp lại, thử lại sau 3 giây — không giật giữa chừng.

/** Panel: đẩy session của conversation hiện tại sang modal monitor. */
function relayForwardSession() {
  if (standaloneView) return;
  if (!("sessionId" in ctx)) return;
  try { window.$crisp?.forwardEvent?.("modal", monitorRelayPayload(ctx.sessionId)); } catch { /* SDK chưa sẵn sàng thì thôi */ }
}

/** Panel: mở modal monitor nổi bằng SDK (cùng plugin thì relay mới tới). */
function openMonitorModal() {
  if (!("sessionId" in ctx)) return;
  const url = monitorModalUrl(location.href, {
    websiteId: ctx.websiteId,
    sessionId: ctx.sessionId,
    token: ctx.crispToken,
    fn: parseFnParam(location.search),
  });
  try { window.$crisp?.showModal?.(url); } catch { /* ngoài Crisp thì bỏ qua */ }
}

let pendingRelaySession = "";
let relayRetryTimer = null;
function applyRelaySession(sid) {
  const url = new URL(location.href);
  url.searchParams.set("session_id", sid);
  location.replace(url.toString());
}
function monitorOnRelayEvent(data) {
  if (standaloneView !== "monitor" && standaloneView !== "swmonitor") return;
  const sid = sessionFromRelayPayload(data);
  if (!sid) return;
  const current = readContext(location.search).sessionId ?? "";
  if (sid === current) return;
  if (state.sfActBusy || state.sfForm || state.busyAction) {
    pendingRelaySession = sid;
    if (!relayRetryTimer) {
      relayRetryTimer = setInterval(() => {
        if (!pendingRelaySession) { clearInterval(relayRetryTimer); relayRetryTimer = null; return; }
        if (state.sfActBusy || state.sfForm || state.busyAction) return;
        const target = pendingRelaySession;
        pendingRelaySession = "";
        applyRelaySession(target);
      }, 3000);
    }
    return;
  }
  applyRelaySession(sid);
}

let monitorRelayStarted = false;
function startMonitorRelay() {
  if ((standaloneView !== "monitor" && standaloneView !== "swmonitor") || monitorRelayStarted) return;
  monitorRelayStarted = true;
  if (monitorSuperseded) { try { $crisp.closeModal(); } catch { /* SDK chưa sẵn sàng thì thôi */ } }
  try { $crisp.onEventForwarded = (data) => monitorOnRelayEvent(data); } catch { /* SDK chưa sẵn sàng thì thôi */ }
}

// Crisp mở một modal MỚI mỗi lần bấm nút (bắt live 30/10 17:47: bấm ở
// chat khác là chồng thêm một thẻ nổi, bản cũ không tự đóng). Các
// iframe modal cùng origin widget nghe nhau qua BroadcastChannel:
// instance monitor mới mở thì instance cũ tự đóng mình. Áp cho cả
// view monitor (Storefront + Jira, mở từ panel) và swmonitor (chỉ
// Storefront, mở từ mặt native của plugin survey — Ethan chốt 02/11
// biến plugin survey thành Storefront Watch monitor only): hai view
// dùng CHUNG kênh để toàn inbox chỉ có một thẻ monitor nổi mỗi lúc.
// swmonitor cũng NGHE relay như monitor: panel Copilot (plugin khác)
// forward session mỗi lần boot — Crisp có chuyển sự kiện forwardEvent
// XUYÊN plugin tới modal đang mở hay không là điểm quyết định bởi test
// live 02/11; nếu sự kiện tới, swmonitor tự nạp lại theo chat mới y hệt
// monitor, nếu không tới thì nó đứng yên như modal native thường.
const MONITOR_BORN_AT = Date.now();
const MONITOR_INSTANCE_ID = `${MONITOR_BORN_AT}-${Math.random().toString(36).slice(2, 8)}`;
let monitorSuperseded = false;
function startMonitorSupersede() {
  if (standaloneView !== "monitor" && standaloneView !== "swmonitor") return;
  try {
    const ch = new BroadcastChannel("copilot-monitor");
    ch.onmessage = (e) => {
      const m = e?.data ?? {};
      if (m.type !== "hello" || m.id === MONITOR_INSTANCE_ID || !(m.ts > MONITOR_BORN_AT)) return;
      monitorSuperseded = true;
      try { window.$crisp?.closeModal?.(); } catch { /* SDK chưa sẵn sàng: startMonitorRelay đóng lại khi ready */ }
    };
    ch.postMessage({ type: "hello", id: MONITOR_INSTANCE_ID, ts: MONITOR_BORN_AT });
  } catch { /* Không có BroadcastChannel thì bỏ qua cơ chế thay thế */ }
}

let standaloneOpened = false;
function openStandaloneView() {
  if (standaloneOpened) return;
  standaloneOpened = true;
  const name = openModalName(parseOpenParam(location.search));
  if (name) openModal(name);
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
      // Đổi chat: xoá MỌI trạng thái của chat cũ (kể cả shop Storefront đã
      // resolve/đã nhập) trước khi nạp chat mới — hàm thuần ở state.js,
      // có test khoá riêng ở session-isolation.test.js.
      resetSessionScopedState(state);
      clearNotice(); // huỷ hẹn giờ tự tắt của thông báo cũ (trạng thái đã reset ở trên)
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
    if (standaloneView) openStandaloneView();
    else applyOpenDeepLink(sessionId);
    maybeAutoRefreshSentiment(sessionId);
    // Mirror Jira cũ lúc mở panel: server đã cho sync chạy nền (check
    // không còn chờ Jira nữa) — nạp lại ĐÚNG một lần sau 3 giây để card
    // Jira nhận bản mới, lần mở đầu vẫn hiện ngay.
    if (state.check?.jira_stale && state.jiraReloadFor !== sessionId) {
      state.jiraReloadFor = sessionId;
      setTimeout(() => {
        if (readContext(location.search).sessionId === sessionId) load();
      }, 3000);
    }
    // Module Storefront được server bật mà chat này chưa có dữ liệu: tự nạp
    // luôn — server tự resolve shop từ custom data của phiên; phiên không có
    // sẵn shopify_domain thì server trả need_shop và module hiện ô nhập tay.
    if (enabledModules(state.check).storefront && !state.storefront) onStorefrontLoad();
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
    relayForwardSession();
  };
  $crisp.acquireData("operator");
  startMonitorRelay();
};

const ctx = readContext(location.search);
if ("error" in ctx) showMessage(ctx.error);
else showLoading("Đang xác định CS đang đăng nhập…");
extension.detectExtension();
startMonitorSupersede();
// Esc đóng popup đang mở (bấm ra ngoài hộp cũng đóng — xem modalView ở panels.js).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.modal) closeModal();
});
window.addEventListener("focus", () => {
  if (state.bridge !== "ready") extension.detectExtension();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.bridge !== "ready") extension.detectExtension();
});
