import { mapError, readContext, toViewModel } from "./core.js";

const API = "https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot";
const TOKEN_KEY = "copilot_token";
const app = document.getElementById("app");
let memoryToken = "";

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || memoryToken; } catch { return memoryToken; }
}
function setToken(t) {
  memoryToken = t;
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* chỉ giữ trong phiên */ }
}
function fit() {
  try { window.$crisp?.setHeight?.(Math.min(document.body.scrollHeight + 8, 350)); } catch { /* ngoài Crisp */ }
}
function el(tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) n.append(c);
  return n;
}
function show(...nodes) {
  app.replaceChildren(...nodes);
  fit();
}

function showToken(hint) {
  const form = document.getElementById("token-form").content.firstElementChild.cloneNode(true);
  form.querySelector(".hint").textContent = hint ?? "Token do người quản lý copilot cấp, chỉ nhập một lần.";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    setToken(form.querySelector("input").value.trim());
    load();
  });
  show(form);
  form.querySelector("input").focus();
}

function showMessage(text, retry) {
  show(el("p", { className: "muted", textContent: text }), ...(retry ? [el("button", { textContent: "Thử lại", onclick: load })] : []));
}

function render(check) {
  const vm = toViewModel(check, Date.now());
  const head = el("div", { className: "row" }, [
    el("h2", { textContent: vm.header }),
    el("button", { textContent: "↻", title: "Làm mới", onclick: load }),
  ]);
  const nodes = [head];
  if (vm.stale) nodes.push(el("span", { className: "badge", textContent: "Dữ liệu có thể chậm vài phút" }));
  if (vm.unanswered.length) {
    nodes.push(el("ul", { className: "pending" }, vm.unanswered.map((t) => el("li", { textContent: t }))));
  }
  nodes.push(el("ul", { className: "meta" }, vm.meta.map((t) => el("li", { textContent: t }))));
  show(...nodes);
}

async function load() {
  const ctx = readContext(location.search);
  if ("error" in ctx) return showMessage(ctx.error);
  const token = getToken();
  if (!token) return showToken();
  showMessage("Đang kiểm tra…");
  let res, body = {};
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-copilot-token": token },
      body: JSON.stringify({ website_id: ctx.websiteId, session_id: ctx.sessionId, action: "check" }),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    return showMessage(mapError(0, {}).message, true);
  }
  if (res.ok) return render(body);
  const err = mapError(res.status, body);
  if (err.kind === "needToken") { setToken(""); return showToken(err.message); }
  showMessage(err.message, err.kind !== "forbidden");
}

window.CRISP_READY_TRIGGER = fit;
load();
