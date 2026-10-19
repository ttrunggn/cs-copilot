// Giao thức widget ↔ extension (spec 6.3, protocol 1). Thuần, không chạm DOM.
export const PROTOCOL = 1;
export const PING_TIMEOUT_MS = 1000;

export function newRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function insertMessage({ requestId, outputId, sessionId, text, mode }) {
  return { type: "copilot:insert", protocol: PROTOCOL, request_id: requestId, output_id: outputId, session_id: sessionId, text, mode };
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
