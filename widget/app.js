import { mapError, readContext, toViewModel } from "./core.js";

const API = "https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot";
const app = document.getElementById("app");
let operatorId = "";

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
  if (!operatorId) return showMessage("Đang xác định CS đang đăng nhập…");
  showMessage("Đang kiểm tra…");
  let res, body = {};
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        website_id: ctx.websiteId,
        session_id: ctx.sessionId,
        crisp_token: ctx.crispToken,
        operator_id: operatorId,
        action: "check",
      }),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    return showMessage(mapError(0, {}).message, true);
  }
  if (res.ok) return render(body);
  const err = mapError(res.status, body);
  showMessage(err.message, err.kind === "retry" || err.kind === "fatal");
}

// CS đang đăng nhập lấy từ SDK chính thức của Crisp, không cần nhập token.
window.CRISP_READY_TRIGGER = () => {
  $crisp.onDataAcquired = (namespace) => {
    if (namespace !== "operator") return;
    operatorId = String($crisp.data.operator?.user_id ?? "");
    if (!operatorId) return showMessage("Plugin chưa có quyền đọc thông tin CS (scope website:operators)");
    load();
  };
  $crisp.acquireData("operator");
};
load();
