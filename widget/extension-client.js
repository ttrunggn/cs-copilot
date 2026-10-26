import { insertResultMessage, readContext } from "./core.js";
import { acceptReply, bridgeState, draftInsert, insertMessage, newRequestId, PING_TIMEOUT_MS, PROTOCOL } from "./bridge-core.js";
import { state } from "./state.js";

const INSERT_TIMEOUT_MS = 3000;

/**
 * Giao tiếp với Chrome extension qua window.postMessage: ping để nhận diện
 * extension và gửi lệnh điền draft vào ô Reply / private note vào ô Note.
 * `render` và `notify` được truyền vào từ app.js để module này không phải
 * import vòng về app.js.
 */
export function createExtensionClient(render, notify) {
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
          // Giữ lại số version để panel hiện minh bạch + cảnh báo bản cũ:
          // protocol không phân biệt được 1.2.0 với 1.2.1 (xem bridge-core).
          state.bridgeVersion = typeof pong.version === "string" ? pong.version : "";
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
      notify(insertResultMessage("session_mismatch"), "error");
      return render();
    }
    state.insertPending = true;
    state.choiceFor = "draft"; // hàng nút Thay thế/Chèn phải trỏ về draft, kể cả khi trước đó vừa điền review
    notify("Đang điền draft vào ô Reply…", "info");
    render();
    const onMsg = (ev) => {
      const r = acceptReply(ev, window, requestId);
      if (!r) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      state.insertPending = false;
      state.choice = r.status === "not_empty";
      if (r.status === "inserted" || r.status === "duplicate") state.draftPlacement = "inserted";
      notify(
        state.choice ? `${insertResultMessage(r.status)}: chèn vào sẽ thay thế toàn bộ nội dung hiện có` : insertResultMessage(r.status),
        state.choice ? "info" : r.status === "inserted" || r.status === "duplicate" ? "success" : "error",
      );
      render();
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      state.insertPending = false;
      notify(insertResultMessage("composer_not_found"), "error");
      render();
    }, INSERT_TIMEOUT_MS);
    window.addEventListener("message", onMsg);
    window.postMessage(msg, location.origin);
  }

  /**
   * Điền tin xin review vào ô Reply: cùng protocol copilot:insert như draft
   * (extension chỉ cần text + session), nhưng output_id là mã tổng hợp riêng
   * cho review để cơ chế chống điền trùng của draft không lẫn sang.
   * mode "auto": ô Reply có chữ → trả not_empty, panel hỏi Thay thế/Chèn/Huỷ
   * qua state.choice (choiceFor = "review") y như luồng draft.
   */
  function sendReviewInsert(mode) {
    if (state.insertPending) return;
    const ctx = readContext(location.search);
    if ("error" in ctx) {
      notify(ctx.error, "error");
      return render();
    }
    if (!state.reviewText.trim()) {
      notify("Chưa có nội dung tin xin review để điền.", "error");
      return render();
    }
    if (!state.reviewInsertId) state.reviewInsertId = `review-${newRequestId()}`;
    const requestId = newRequestId();
    const msg = insertMessage({ requestId, outputId: state.reviewInsertId, sessionId: ctx.sessionId, text: state.reviewText, mode });
    state.insertPending = true;
    state.choiceFor = "review";
    notify("Đang điền tin xin review vào ô Reply…", "info");
    render();
    const onMsg = (ev) => {
      const r = acceptReply(ev, window, requestId);
      if (!r) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      state.insertPending = false;
      state.choice = r.status === "not_empty";
      notify(
        state.choice
          ? `${insertResultMessage(r.status)}: chèn vào sẽ thay thế toàn bộ nội dung hiện có`
          : r.status === "inserted" || r.status === "duplicate"
          ? "Đã điền tin xin review vào ô Reply, đọc lại rồi bấm Send"
          : insertResultMessage(r.status),
        state.choice ? "info" : r.status === "inserted" || r.status === "duplicate" ? "success" : "error",
      );
      render();
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      state.insertPending = false;
      notify(insertResultMessage("composer_not_found"), "error");
      render();
    }, INSERT_TIMEOUT_MS);
    window.addEventListener("message", onMsg);
    window.postMessage(msg, location.origin);
  }

  /**
   * Điền mẫu giải thích finding Storefront vào ô Reply: cùng protocol
   * copilot:insert như draft/review (extension chỉ cần text + session),
   * output_id tổng hợp riêng cho mẫu giải thích để cơ chế chống điền trùng
   * của draft/review không lẫn sang. mode "auto": ô Reply có chữ → not_empty,
   * panel hỏi Thay thế/Chèn/Huỷ qua state.choice (choiceFor = "explain")
   * như các luồng điền khác. Vẫn chỉ là ĐIỀN — CS tự bấm Send trong Crisp.
   */
  function sendExplainInsert(mode) {
    if (state.insertPending) return;
    const ctx = readContext(location.search);
    if ("error" in ctx) {
      notify(ctx.error, "error");
      return render();
    }
    if (!state.explainText.trim()) {
      notify("Chưa có mẫu giải thích để điền.", "error");
      return render();
    }
    if (!state.explainInsertId) state.explainInsertId = `explain-${newRequestId()}`;
    const requestId = newRequestId();
    const msg = insertMessage({ requestId, outputId: state.explainInsertId, sessionId: ctx.sessionId, text: state.explainText, mode });
    state.insertPending = true;
    state.choiceFor = "explain";
    notify("Đang điền mẫu giải thích vào ô Reply…", "info");
    render();
    const onMsg = (ev) => {
      const r = acceptReply(ev, window, requestId);
      if (!r) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      state.insertPending = false;
      state.choice = r.status === "not_empty";
      notify(
        state.choice
          ? `${insertResultMessage(r.status)}: chèn vào sẽ thay thế toàn bộ nội dung hiện có`
          : r.status === "inserted" || r.status === "duplicate"
          ? "Đã điền mẫu giải thích vào ô Reply, đọc lại rồi bấm Send"
          : insertResultMessage(r.status),
        state.choice ? "info" : r.status === "inserted" || r.status === "duplicate" ? "success" : "error",
      );
      render();
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      state.insertPending = false;
      notify(insertResultMessage("composer_not_found"), "error");
      render();
    }, INSERT_TIMEOUT_MS);
    window.addEventListener("message", onMsg);
    window.postMessage(msg, location.origin);
  }

  /**
   * Điền private note vào ô Note của Crisp: cùng protocol copilot:insert như
   * draft/review nhưng target "note" — extension tự bấm tab Note và CHỈ điền
   * khi đã xác nhận Note mode; không xác nhận được thì trả note_unconfirmed
   * và không điền gì cả. mode "auto": ô Note có chữ → not_empty, panel hỏi
   * Thay thế/Chèn/Huỷ qua state.choice (choiceFor = "note") như draft.
   * output_id tổng hợp riêng cho note, reset mỗi khi tạo note mới (app.js).
   */
  function sendNoteInsert(mode) {
    if (state.insertPending) return;
    const ctx = readContext(location.search);
    if ("error" in ctx) {
      notify(ctx.error, "error");
      return render();
    }
    if (!state.handoff?.note.trim()) {
      notify("Chưa có private note để điền.", "error");
      return render();
    }
    if (!state.noteInsertId) state.noteInsertId = `note-${newRequestId()}`;
    const requestId = newRequestId();
    const msg = insertMessage({ requestId, outputId: state.noteInsertId, sessionId: ctx.sessionId, text: state.handoff.note, mode, target: "note" });
    state.insertPending = true;
    state.choiceFor = "note";
    notify("Đang điền note vào ô Note…", "info");
    render();
    const onMsg = (ev) => {
      const r = acceptReply(ev, window, requestId);
      if (!r) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      state.insertPending = false;
      state.choice = r.status === "not_empty";
      if (r.status === "inserted" || r.status === "duplicate") state.notePlacement = "inserted";
      notify(
        state.choice ? `${insertResultMessage(r.status, "note")}: chèn vào sẽ thay thế toàn bộ nội dung hiện có` : insertResultMessage(r.status, "note"),
        state.choice ? "info" : r.status === "inserted" || r.status === "duplicate" ? "success" : "error",
      );
      render();
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      state.insertPending = false;
      notify(insertResultMessage("composer_not_found", "note"), "error");
      render();
    }, INSERT_TIMEOUT_MS);
    window.addEventListener("message", onMsg);
    window.postMessage(msg, location.origin);
  }

  return { pingExtension, detectExtension, sendInsert, sendReviewInsert, sendNoteInsert, sendExplainInsert };
}
