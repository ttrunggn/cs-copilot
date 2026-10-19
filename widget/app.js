import { describeShape, handoffStatus, insertResultMessage, mapError, operatorIdFrom, readContext, toDraftViewModel, toViewModel } from "./core.js";
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
  show(el("p", { className: "muted", textContent: text }), retry ? el("button", { textContent: "Thử lại", onclick: load }) : null);
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
  const onMsg = (ev) => {
    const r = acceptReply(ev, window, requestId);
    if (!r) return;
    window.removeEventListener("message", onMsg);
    clearTimeout(timer);
    choice = r.status === "not_empty";
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
  const text = bridge === "outdated" ? "Extension đã cũ, tải bản mới:" : "Cài extension để điền thẳng vào ô Reply:";
  return el("details", { className: "hint" }, [
    el("summary", { textContent: text }),
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
  const actions = el("div", { className: "row" }, [
    bridge === "ready" ? el("button", { textContent: "Điền lại", onclick: () => sendInsert("replace") }) : null,
    el("button", { textContent: "Copy", onclick: () => copy(vm.text) }),
  ]);
  const ask = choice
    ? el("div", { className: "row" }, [
      el("button", { textContent: "Thay thế", onclick: () => sendInsert("replace") }),
      el("button", { textContent: "Chèn xuống cuối", onclick: () => sendInsert("append") }),
      el("button", { textContent: "Huỷ", onclick: () => ((choice = false), (notice = ""), render()) }),
    ])
    : null;
  return el("section", { className: "card" }, [
    el("div", { className: "row" }, [el("h3", { textContent: vm.age ? `Draft · ${vm.age}` : "Draft" }), el("span", { className: "badge", textContent: vm.badge })]),
    vm.todos ? el("p", { className: "warn", textContent: `Còn ${vm.todos} chỗ cần CS điền` }) : null,
    draftText(vm.text),
    vm.warnings.length
      ? el("ul", { className: "warnings" }, vm.warnings.map((w) =>
        el("li", {}, [
          el("strong", { textContent: `⚠ ${w.claim}` }),
          el("span", { textContent: ` — ${w.reason} ` }),
          w.url ? el("a", { href: w.url, target: "_blank", rel: "noopener noreferrer", textContent: "Xem bài" }) : null,
        ])
      ))
      : null,
    actions,
    ask,
  ]);
}

function handoffPanel() {
  if (!handoff) return null;
  const status = handoffStatus(handoff);
  return el("section", { className: "card" }, [
    el("div", { className: "row" }, [el("h3", { textContent: "Handoff" }), el("span", { className: "badge", textContent: status })]),
    el("div", { className: "draft", textContent: handoff.note }),
    el("div", { className: "row" }, [
      el("button", { textContent: "Copy", onclick: () => copy(handoff.note) }),
      el("button", { textContent: "Viết lại", onclick: () => onHandoff(true) }),
    ]),
  ]);
}

function render() {
  if (!check) return;
  const vm = toViewModel(check, Date.now());
  const disabled = Boolean(busy);
  show(
    el("div", { className: "row" }, [el("h2", { textContent: vm.header }), el("button", { textContent: "↻", title: "Làm mới", onclick: load })]),
    vm.stale ? el("span", { className: "badge", textContent: "Dữ liệu có thể chậm vài phút" }) : null,
    vm.unanswered.length ? el("ul", { className: "pending" }, vm.unanswered.map((t) => el("li", { textContent: t }))) : null,
    el("ul", { className: "meta" }, vm.meta.map((t) => el("li", { textContent: t }))),
    el("div", { className: "actions" }, [
      el("button", { className: "primary", textContent: "📋 Handoff", disabled, onclick: () => onHandoff(false) }),
      el("button", { textContent: "✨ Soạn tin", disabled, onclick: () => onGenerate(false) }),
      el("button", { textContent: "↻ Soạn lại", disabled, onclick: () => onGenerate(true) }),
    ]),
    busy ? el("p", { className: "muted", textContent: busy }) : null,
    notice ? el("p", { className: "notice", textContent: notice }) : null,
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
