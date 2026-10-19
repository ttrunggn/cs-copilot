import { describeShape, handoffStatus, insertResultMessage, toJiraViewModel, mapError, operatorIdFrom, readContext, toDraftViewModel, toViewModel } from "./core.js";
import { acceptReply, bridgeState, draftInsert, newRequestId, PING_TIMEOUT_MS, PROTOCOL } from "./bridge-core.js";

const API = "https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot";
const INSERT_TIMEOUT_MS = 3000;
const app = document.getElementById("app");
let operatorId = "";
let check = null; // kết quả check gần nhất
let draft = null; // { output_id, session_id, vm } — gắn với chat đã soạn
let shownSession = ""; // chat đang hiển thị; đổi chat thì xoá draft/handoff cũ
let handoff = null; // { note, posted, cached }
let notice = ""; // dòng trạng thái dưới draft/handoff
let choice = false; // đang hỏi Thay thế / Chèn cuối / Huỷ
let draftPlacement = ""; // inserted | copied
let busy = "";
let bridge = "missing"; // missing | outdated | ready

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
  if (bridge === "ready") return null;
  const text = bridge === "outdated" ? "Extension đã cũ" : "Chưa cài extension";
  return el("details", { className: "hint" }, [
    el("summary", { textContent: text }),
    el("strong", { textContent: bridge === "outdated" ? "Extension đã cũ, tải bản mới" : "Cài extension để điền thẳng vào ô Reply" }),
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
  return el("section", { className: "card draft-card" }, [
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
    ]),
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
    draftPanel(),
    extensionHint(),
  );
}

async function load() {
  if (!operatorId) return showMessage("Đang xác định CS đang đăng nhập…");
  const sessionId = readContext(location.search).sessionId;
  if (sessionId !== shownSession) {
    shownSession = sessionId;
    draft = null;
    handoff = null;
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
pingExtension().then((pong) => {
  bridge = bridgeState(pong);
  render();
});
