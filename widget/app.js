import { describeShape, handoffStatus, insertResultMessage, toJiraViewModel, mapError, operatorIdFrom, readContext, toDraftViewModel, toViewModel } from "./core.js";
import { acceptReply, bridgeState, draftInsert, newRequestId, PING_TIMEOUT_MS, PROTOCOL } from "./bridge-core.js";

const API = "https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot";
const INSERT_TIMEOUT_MS = 3000;
const app = document.getElementById("app");
const requestedTheme = new URLSearchParams(location.search).get("theme");
if (requestedTheme === "light" || requestedTheme === "dark") document.documentElement.dataset.theme = requestedTheme;
let operatorId = "";
let check = null; // kết quả check gần nhất
let draft = null; // { output_id, session_id, vm } — gắn với chat đã soạn
let shownSession = ""; // chat đang hiển thị; đổi chat thì xoá draft/handoff cũ
let handoff = null; // { note, posted, cached }
let notice = ""; // dòng trạng thái dưới draft/handoff
let choice = false; // đang hỏi Thay thế / Chèn cuối / Huỷ
let draftPlacement = ""; // inserted | copied
let knowledgeOpen = false; // UI scaffold: sẽ nối FAQ search sau
let busy = "";
let bridge = "checking"; // checking | missing | outdated | ready
let bridgeProbe = null;

function fit() {
  try { window.$crisp?.setHeight?.(Math.min(document.body.scrollHeight + 8, 700)); } catch { /* ngoài Crisp */ }
}
function el(tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c) n.append(c);
  return n;
}
function show(...nodes) {
  app.replaceChildren(...nodes.filter(Boolean));
  fit();
}
function showMessage(text, retry) {
  show(el("section", { className: "state-card" }, [
    el("p", { className: "state-title", textContent: text }),
    retry ? el("button", { className: "button-secondary", textContent: "Thử lại", onclick: load }) : null,
  ]));
}

// ---------- extension ----------

function pingExtension() {
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      if (ev.source !== window || ev.data?.type !== "copilot:pong") return;
      window.removeEventListener("message", onMsg);
      resolve(ev.data);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ type: "copilot:ping", protocol: PROTOCOL }, location.origin);
    setTimeout(() => (window.removeEventListener("message", onMsg), resolve(null)), PING_TIMEOUT_MS);
  });
}

/**
 * Content script của Chrome đôi lúc được inject sau khi widget đã chạy.
 * Đừng kết luận "chưa cài" từ một lần ping sớm; thử lại ngắn gọn khi mở panel
 * và khi CS quay lại tab.
 */
async function detectExtension() {
  if (bridgeProbe) return bridgeProbe;
  bridge = "checking";
  render();
  bridgeProbe = (async () => {
    for (const delay of [0, 300, 1000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const pong = await pingExtension();
      if (pong) {
        bridge = bridgeState(pong);
        render();
        return;
      }
    }
    bridge = "missing";
    render();
  })().finally(() => { bridgeProbe = null; });
  return bridgeProbe;
}

function sendInsert(mode) {
  const ctx = readContext(location.search);
  const requestId = newRequestId();
  const msg = "error" in ctx ? null : draftInsert(draft, ctx.sessionId, requestId, mode);
  if (!msg) {
    notice = insertResultMessage("session_mismatch");
    return render();
  }
  notice = "Đang điền draft vào ô Reply…";
  render();
  const onMsg = (ev) => {
    const r = acceptReply(ev, window, requestId);
    if (!r) return;
    window.removeEventListener("message", onMsg);
    clearTimeout(timer);
    choice = r.status === "not_empty";
    if (r.status === "inserted" || r.status === "duplicate") draftPlacement = "inserted";
    notice = choice ? `${insertResultMessage(r.status)}: thay thế, chèn xuống cuối hay huỷ?` : insertResultMessage(r.status);
    render();
  };
  const timer = setTimeout(() => {
    window.removeEventListener("message", onMsg);
    notice = insertResultMessage("composer_not_found");
    render();
  }, INSERT_TIMEOUT_MS);
  window.addEventListener("message", onMsg);
  window.postMessage(msg, location.origin);
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
  if (draft && text === draft.vm.text) draftPlacement = "copied";
  notice = "Đã copy, dán vào ô Reply bằng Ctrl+V";
  render();
}

// ---------- API ----------

async function call(action, extra = {}) {
  const ctx = readContext(location.search);
  if ("error" in ctx) throw { message: ctx.error };
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ website_id: ctx.websiteId, session_id: ctx.sessionId, crisp_token: ctx.crispToken, operator_id: operatorId, action, ...extra }),
  }).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  // Response về khi CS đã chuyển sang chat khác thì bỏ (spec 6.4 #2).
  if (readContext(location.search).sessionId !== ctx.sessionId) throw { stale: true };
  if (!res || !res.ok) throw mapError(res ? res.status : 0, body);
  return body;
}

async function onGenerate(force) {
  busy = force ? "Đang soạn lại…" : "Đang soạn…";
  notice = "";
  choice = false;
  render();
  try {
    const sessionId = readContext(location.search).sessionId;
    const out = await call("generate", force ? { force: true } : {});
    draft = { output_id: out.output_id, session_id: sessionId, vm: toDraftViewModel(out) };
    draftPlacement = "";
    busy = "";
    render();
    if (bridge === "ready") sendInsert("auto");
  } catch (e) {
    busy = "";
    if (!e.stale) notice = e.message ?? "Không soạn được, thử lại sau";
    render();
  }
}

async function onHandoff(force) {
  busy = "Đang viết handoff…";
  notice = "";
  render();
  try {
    const out = await call("handoff", force ? { force: true } : {});
    handoff = { note: out.note, posted: out.posted, cached: out.cached };
    busy = "";
    render();
  } catch (e) {
    busy = "";
    if (!e.stale) notice = e.message ?? "Không tạo được handoff, thử lại sau";
    render();
  }
}

// ---------- render ----------

/** Hiện draft, tô vàng các chỗ [[CS: …]] để CS không gửi nhầm. */
function draftText(text) {
  const box = el("div", { className: "draft" });
  for (const part of text.split(/(\[\[CS:[^\]]*\]\])/)) {
    if (part) box.append(part.startsWith("[[CS:") ? el("mark", { className: "todo", textContent: part }) : document.createTextNode(part));
  }
  return box;
}

function extensionHint() {
  if (bridge === "ready" || bridge === "checking") return null;
  const outdated = bridge === "outdated";
  const text = outdated ? "Extension cần cập nhật" : "Không nhận diện được extension";
  return el("details", { className: "hint" }, [
    el("summary", { textContent: text }),
    el("strong", { textContent: outdated ? "Tải và cài lại bản extension mới" : "Nếu đã cài, tải lại trang Crisp hoặc bấm kiểm tra lại" }),
    !outdated ? el("button", { className: "button-link", textContent: "Kiểm tra lại", onclick: detectExtension }) : null,
    el("ol", {}, [
      el("li", {}, [el("a", { href: "extension.zip", textContent: "Tải extension.zip", download: "cs-copilot-extension.zip" })]),
      el("li", { textContent: "Giải nén ra một thư mục" }),
      el("li", { textContent: "Mở chrome://extensions, bật Developer mode" }),
      el("li", { textContent: "Bấm Load unpacked, chọn thư mục vừa giải nén, rồi tải lại Crisp" }),
    ]),
  ]);
}

function draftPanel() {
  if (!draft) return null;
  const vm = draft.vm;
  const actions = el("div", { className: "row draft-actions" }, [
    bridge === "ready" ? el("button", { className: "button-primary", textContent: "Điền vào Reply", onclick: () => sendInsert("replace") }) : null,
    el("button", { className: bridge === "ready" ? "button-secondary" : "button-primary", textContent: "Copy", onclick: () => copy(vm.text) }),
    el("button", { className: "button-link", textContent: "Soạn lại", disabled: Boolean(busy), onclick: () => onGenerate(true) }),
  ]);
  return el("section", { className: "card ai-card draft-card" }, [
    el("div", { className: "draft-heading" }, [
      el("h2", { textContent: "Draft cho tin này" }),
      el("p", { className: draftPlacement ? "success-line" : "muted", textContent: draftPlacement === "inserted"
        ? "Đã điền draft vào ô Reply, đọc lại rồi bấm Send"
        : draftPlacement === "copied"
        ? "Đã copy, dán vào ô Reply bằng Ctrl+V"
        : bridge === "ready" ? "Extension sẵn sàng điền draft vào ô Reply" : "Đọc lại draft rồi copy vào ô Reply nhé" }),
    ]),
    el("div", { className: "draft-meta" }, [
      el("span", { className: "muted", textContent: vm.age ? `Soạn ${vm.age}` : "Soạn vừa xong" }),
      el("span", { className: `verify-state ${vm.verified ? "is-ok" : "is-warn"}`, textContent: `${vm.verified ? "✓" : "!"} ${vm.badge}` }),
    ]),
    vm.todos ? el("p", { className: "warn", textContent: `Còn ${vm.todos} chỗ cần bạn điền trước khi gửi` }) : null,
    draftText(vm.text),
    vm.warnings.length
      ? el("div", { className: "warnings" }, vm.warnings.map((w) =>
        el("div", { className: "warning-item" }, [
          el("span", {}, [el("strong", { textContent: "Cần kiểm tra: " }), document.createTextNode(`${w.claim}${w.reason ? `. ${w.reason}` : ""} `)]),
          w.url ? el("a", { href: w.url, target: "_blank", rel: "noopener noreferrer", textContent: "Xem bài" }) : null,
        ])
      ))
      : null,
    actions,
  ]);
}

function handoffPanel() {
  if (!handoff) return null;
  const status = handoffStatus(handoff);
  return el("section", { className: "handoff-card" }, [
    el("div", { className: "row" }, [el("h3", { textContent: "🔒 Private note" }), el("span", { className: handoff.posted ? "verify-state is-ok" : "verify-state is-warn", textContent: handoff.posted ? `✓ ${status}` : status })]),
    el("div", { className: "note-text", textContent: handoff.note }),
    el("div", { className: "row" }, [
      el("button", { className: "button-secondary", textContent: "Copy", onclick: () => copy(handoff.note) }),
      el("button", { className: "button-link", textContent: "Viết lại", disabled: Boolean(busy), onclick: () => onHandoff(true) }),
    ]),
  ]);
}

function jiraPanel() {
  const items = toJiraViewModel(check?.jira);
  if (!items.length) return null;
  return el("section", { className: "jira-section" }, [
    el("h2", { className: "section-title", textContent: `Ticket Jira · ${items.length}` }),
    ...items.map((j) =>
    el("div", { className: "jira" }, [
      el("div", { className: "row" }, [
        j.url ? el("a", { href: j.url, target: "_blank", rel: "noopener noreferrer", textContent: j.title }) : el("strong", { textContent: j.title }),
        j.isNew ? el("span", { className: "badge new", textContent: "MỚI" }) : null,
      ]),
      j.summary ? el("p", { className: "muted", textContent: j.summary }) : null,
      j.news.length ? el("ul", { className: "jira-news" }, j.news.map((t) => el("li", { textContent: t }))) : el("p", { className: "muted", textContent: "Chưa có tóm tắt hay cập nhật mới." }),
    ])
    ),
  ]);
}

function pendingMessageCard(m) {
  const children = [el("p", { textContent: m.text })];
  if (m.imageUrl) {
    const image = el("img", { src: m.imageUrl, alt: "Ảnh khách gửi", loading: "lazy", referrerPolicy: "no-referrer" });
    const fallback = el("span", { className: "image-fallback", textContent: "Không tải được ảnh · Mở ảnh gốc" });
    fallback.hidden = true;
    image.onerror = () => {
      image.hidden = true;
      fallback.hidden = false;
    };
    children.push(el("a", {
      className: "customer-image-link",
      href: m.imageUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Mở ảnh khách gửi ở tab mới",
    }, [image, fallback]));
  }
  if (m.botReplied) children.push(el("span", { className: "bot-replied", textContent: "Bot đã phản hồi · cần CS rà soát" }));
  return el("article", { className: `pending-message${m.imageUrl ? " has-image" : ""}` }, children);
}

/** Các khối dưới đây là UI scaffold theo SPEC v1; chưa gọi API để không giả dữ liệu. */
function insightPanel() {
  return el("section", { className: "card insight-card future-card" }, [
    el("div", { className: "row" }, [
      el("span", { className: "eyebrow", textContent: "Ý ĐỊNH & TÂM TRẠNG" }),
      el("button", { className: "button-secondary compact-button", textContent: "Phân tích lại", disabled: true, title: "Sẽ nối service sentiment" }),
    ]),
    el("strong", { className: "future-title", textContent: "Chưa có dữ liệu phân tích" }),
    el("p", { className: "muted", textContent: "Ý định, mood và điểm sentiment sẽ hiển thị tại đây sau khi tích hợp." }),
  ]);
}

function knowledgePanel() {
  if (!knowledgeOpen) return null;
  return el("section", { className: "card ai-card knowledge-card future-card" }, [
    el("div", {}, [
      el("h2", { textContent: "Hỏi tài liệu" }),
      el("p", { className: "subtitle", textContent: "Tìm trong FAQ nội bộ, trả lời kèm nguồn" }),
    ]),
    el("textarea", { className: "field", rows: 3, placeholder: "Nhập câu hỏi hoặc vấn đề của khách…", disabled: true }),
    el("p", { className: "muted", textContent: "Tìm kiếm tài liệu sẽ được nối ở bước tiếp theo; không có nguồn thì panel sẽ không đoán chính sách." }),
    el("button", { className: "button-primary", textContent: "Tìm trong tài liệu", disabled: true }),
  ]);
}

function techPanel() {
  if (!handoff) return null;
  return el("section", { className: "card ai-card tech-card future-card" }, [
    el("div", {}, [
      el("h2", { textContent: "Báo Tech" }),
      el("p", { className: "subtitle", textContent: "Chỉ gửi khi CS bấm. Gửi qua Gmail của team." }),
    ]),
    el("div", { className: "field field-static", textContent: "Nội dung email sẽ được tạo từ báo cáo đóng chat và ticket Jira." }),
    el("p", { className: "muted", textContent: "Gmail OAuth, người nhận và trạng thái gửi sẽ được nối sau." }),
    el("button", { className: "button-primary", textContent: "Xem lại và gửi", disabled: true }),
  ]);
}

function csatPanel() {
  return el("section", { className: "csat-panel future-card" }, [
    el("span", { className: "eyebrow", textContent: "SEND SURVEY" }),
    el("p", { className: "muted", textContent: "Cảnh báo mood và trạng thái đã gửi sẽ hiển thị khi CSAT được nối." }),
    el("button", { className: "csat-button", textContent: "Send CSAT Survey", disabled: true }),
  ]);
}

function render() {
  if (!check) return;
  const vm = toViewModel(check, Date.now());
  const disabled = Boolean(busy);
  show(
    el("header", { className: "inbox-header" }, [
      el("div", {}, [el("h1", { textContent: vm.header }), el("p", { className: "subtitle", textContent: vm.subtitle })]),
      el("button", { className: "refresh-button", textContent: "↻", title: "Làm mới", onclick: load }),
    ]),
    vm.stale ? el("p", { className: "stale-line", textContent: "Dữ liệu có thể chậm vài phút" }) : null,
    insightPanel(),
    vm.pendingMessages.length ? el("section", { className: "pending-section" }, [
      ...vm.pendingMessages.map(pendingMessageCard),
      vm.hiddenPendingCount ? el("p", { className: "muted", textContent: `Đang hiện ${vm.pendingMessages.length} trong ${vm.pendingCount} tin` }) : null,
    ]) : el("div", { className: "empty-state" }, [
      el("h2", { textContent: "Hết tin chờ rồi" }),
      el("p", { className: "subtitle", textContent: vm.subtitle }),
    ]),
    el("div", { className: "actions" }, [
      el("button", { className: "button-primary compose-button", textContent: busy.startsWith("Đang soạn") ? "Đang soạn…" : "Soạn tin trả lời", disabled, onclick: () => onGenerate(false) }),
      el("button", { className: "button-secondary private-button", textContent: busy.startsWith("Đang viết") ? "Đang viết private note…" : "🔒  Private note", disabled, onclick: () => onHandoff(false) }),
      el("button", { className: "button-secondary knowledge-button", textContent: "Hỏi tài liệu", onclick: () => ((knowledgeOpen = !knowledgeOpen), render()) }),
    ]),
    knowledgePanel(),
    busy ? el("div", { className: "loading-card" }, [
      el("p", { className: "muted", textContent: busy }),
      el("div", { className: "skeleton" }, [el("i"), el("i"), el("i")]),
    ]) : null,
    notice ? el("div", { className: `notice-card ${notice.startsWith("Đã") ? "success-notice" : ""}`, textContent: notice }) : null,
    choice ? el("div", { className: "insert-choice" }, [
      el("p", { className: "success-line", textContent: "Ô Reply đang có chữ: thay thế, chèn xuống cuối hay huỷ?" }),
      el("div", { className: "row" }, [
        el("button", { className: "button-primary", textContent: "Thay thế", onclick: () => sendInsert("replace") }),
        el("button", { className: "button-secondary", textContent: "Chèn xuống cuối", onclick: () => sendInsert("append") }),
        el("button", { className: "button-secondary", textContent: "Huỷ", onclick: () => ((choice = false), (notice = ""), render()) }),
      ]),
    ]) : null,
    el("section", { className: "meta-section" }, vm.metaRows.map((m) => el("div", { className: "meta-row" }, [
      el("span", { className: "muted", textContent: m.label }), el("span", { textContent: m.value }),
    ]))),
    jiraPanel(),
    handoffPanel(),
    techPanel(),
    draftPanel(),
    extensionHint(),
    csatPanel(),
  );
}

async function load() {
  if (!operatorId) return showMessage("Đang xác định CS đang đăng nhập…");
  const sessionId = readContext(location.search).sessionId;
  if (sessionId !== shownSession) {
    shownSession = sessionId;
    draft = null;
    handoff = null;
    knowledgeOpen = false;
    choice = false;
    draftPlacement = "";
    notice = "";
  }
  showMessage("Đang kiểm tra…");
  try {
    check = await call("check");
  } catch (e) {
    if (e.stale) return;
    return showMessage(e.message ?? "Không kết nối được copilot", e.kind === "retry" || e.kind === "fatal");
  }
  if (check.latest_draft && !draft) {
    draft = { output_id: check.latest_draft.output_id, session_id: sessionId, vm: toDraftViewModel(check.latest_draft) };
  }
  render();
}

// CS đang đăng nhập lấy từ SDK chính thức của Crisp, không cần nhập token.
window.CRISP_READY_TRIGGER = () => {
  $crisp.onDataAcquired = (namespace) => {
    if (namespace !== "operator") return;
    operatorId = operatorIdFrom($crisp.data.operator);
    if (!operatorId) {
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
detectExtension();
window.addEventListener("focus", () => {
  if (bridge !== "ready") detectExtension();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && bridge !== "ready") detectExtension();
});
