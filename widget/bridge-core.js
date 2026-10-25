// Giao thức widget ↔ extension (spec 6.3). Thuần, không chạm DOM.
// Protocol 2: insert có thêm `target` ("reply" | "note"). Extension protocol 1
// không biết target — widget coi là outdated và không cho điền note, tránh
// cảnh extension cũ điền nội dung note vào ô Reply cho khách thấy.
export const PROTOCOL = 2;
export const PING_TIMEOUT_MS = 1000;

export function newRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function insertMessage({ requestId, outputId, sessionId, text, mode, target = "reply" }) {
  return { type: "copilot:insert", protocol: PROTOCOL, request_id: requestId, output_id: outputId, session_id: sessionId, text, mode, target };
}

/** Chỉ nhận insert_result do extension gửi vào chính cửa sổ này, đúng request đang chờ. */
export function acceptReply(ev, win, pendingId) {
  const d = ev?.data;
  if (ev?.source !== win || d?.type !== "copilot:insert_result" || !pendingId || d.request_id !== pendingId) return null;
  return d;
}

export function bridgeState(pong) {
  if (!pong) return "missing";
  return pong.protocol === PROTOCOL ? "ready" : "outdated";
}

/** Lệnh chèn cho một draft: luôn dùng session của chính draft, và từ chối nếu đang mở chat khác. */
export function draftInsert(draft, currentSessionId, requestId, mode) {
  if (!draft || draft.session_id !== currentSessionId) return null;
  return insertMessage({ requestId, outputId: draft.output_id, sessionId: draft.session_id, text: draft.vm.text, mode });
}
