// Giao thức widget ↔ extension (spec 6.3). Thuần, không chạm DOM.
// Protocol 2: insert có thêm `target` ("reply" | "note"). Extension protocol 1
// không biết target — widget coi là outdated và không cho điền note, tránh
// cảnh extension cũ điền nội dung note vào ô Reply cho khách thấy.
export const PROTOCOL = 2;
export const PING_TIMEOUT_MS = 1000;

/**
 * Bản extension mới nhất mà widget này đi kèm. Protocol 2 không đổi giữa
 * 1.2.0 và 1.2.1 nên bridgeState không phân biệt được hai bản — mà hành vi
 * điền khác hẳn nhau (1.2.0 chèn nối, 1.2.1 thay toàn bộ có kiểm chứng).
 * Panel phải so SỐ VERSION extension tự khai trong pong và cảnh báo rõ khi
 * đang ở bản cũ, thay vì báo "sẵn sàng" rồi CS lãnh đủ lỗi cũ (Ethan test
 * live 2026-10-26: tưởng đã cài 1.2.1 nhưng Chrome vẫn chạy bản cũ).
 */
export const EXPECTED_EXTENSION_VERSION = "1.2.6";

/** So sánh semver rút gọn (các thành phần số, cách nhau bởi dấu chấm). */
function versionParts(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  const parts = v.trim().split(".").map((p) => Number(p));
  return parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}

/** true khi version extension THẤP hơn bản kỳ vọng; không rõ version thì false (không cảnh báo bừa). */
export function extensionOutdated(version, expected = EXPECTED_EXTENSION_VERSION) {
  const a = versionParts(version);
  const b = versionParts(expected);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d < 0) return true;
    if (d > 0) return false;
  }
  return false;
}

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

/**
 * Tổng kết các pong nhận được trong một cửa sổ ping. Mỗi bản extension cài
 * trong Chrome inject bridge riêng vào iframe widget và trả pong kèm mã
 * định danh của nó (trường ext) — HAI mã khác nhau nghĩa là hai bản đang
 * chạy song song (bản cũ chưa gỡ hẳn): mọi lệnh điền bị thực thi hai lần,
 * ô Reply gấp đôi nội dung, ô Note thì hai bản giành nhau (ca live
 * 2026-10-26). Panel phải cảnh báo thay vì báo "sẵn sàng" mù.
 */
export function respondersSummary(pongs) {
  const list = (pongs ?? []).filter(Boolean);
  const ids = new Set(list.map((p) => (typeof p.ext === "string" && p.ext) || "anon"));
  const versions = [...new Set(list.map((p) => p.version).filter((v) => typeof v === "string" && v !== ""))];
  return { count: list.length, conflict: ids.size > 1, versions };
}

/** Lệnh chèn cho một draft: luôn dùng session của chính draft, và từ chối nếu đang mở chat khác. */
export function draftInsert(draft, currentSessionId, requestId, mode) {
  if (!draft || draft.session_id !== currentSessionId) return null;
  return insertMessage({ requestId, outputId: draft.output_id, sessionId: draft.session_id, text: draft.vm.text, mode });
}
