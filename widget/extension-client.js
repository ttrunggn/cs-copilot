import { insertResultMessage, readContext } from "./core.js";
import { acceptReply, bridgeState, draftInsert, newRequestId, PING_TIMEOUT_MS, PROTOCOL } from "./bridge-core.js";
import { state } from "./state.js";

const INSERT_TIMEOUT_MS = 3000;

/**
 * Giao tiếp với Chrome extension qua window.postMessage: ping để nhận diện
 * extension và gửi lệnh điền draft vào ô Reply. `render` được truyền vào từ
 * app.js để module này không phải import vòng về app.js.
 */
export function createExtensionClient(render) {
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
    if (state.bridgeProbe) return state.bridgeProbe;
    state.bridge = "checking";
    render();
    state.bridgeProbe = (async () => {
      for (const delay of [0, 300, 1000]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const pong = await pingExtension();
        if (pong) {
          state.bridge = bridgeState(pong);
          render();
          return;
        }
      }
      state.bridge = "missing";
      render();
    })().finally(() => { state.bridgeProbe = null; });
    return state.bridgeProbe;
  }

  function sendInsert(mode) {
    if (state.insertPending) return; // một lệnh điền tại một thời điểm — bấm đúp không chèn hai lần
    const ctx = readContext(location.search);
    const requestId = newRequestId();
    const msg = "error" in ctx ? null : draftInsert(state.draft, ctx.sessionId, requestId, mode);
    if (!msg) {
      state.notice = insertResultMessage("session_mismatch");
      return render();
    }
    state.insertPending = true;
    state.notice = "Đang điền draft vào ô Reply…";
    render();
    const onMsg = (ev) => {
      const r = acceptReply(ev, window, requestId);
      if (!r) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      state.insertPending = false;
      state.choice = r.status === "not_empty";
      if (r.status === "inserted" || r.status === "duplicate") state.draftPlacement = "inserted";
      state.notice = state.choice ? `${insertResultMessage(r.status)}: thay thế, chèn xuống cuối hay huỷ?` : insertResultMessage(r.status);
      render();
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      state.insertPending = false;
      state.notice = insertResultMessage("composer_not_found");
      render();
    }, INSERT_TIMEOUT_MS);
    window.addEventListener("message", onMsg);
    window.postMessage(msg, location.origin);
  }

  return { pingExtension, detectExtension, sendInsert };
}
