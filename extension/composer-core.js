// Logic thuần của extension (không chạm DOM/chrome.*). Build gộp file này vào đầu từng content script.

/** "/inbox/session_xxx/" trong URL Crisp → "session_xxx". */
export function sessionFromUrl(href) {
  const m = String(href).match(/\/(session_[\w-]+)/);
  return m ? m[1] : null;
}

/**
 * Quyết định chèn draft vào ô Reply (spec 6.4). Trả text cuối cùng cần có trong ô khi được chèn.
 * auto: chỉ chèn khi đúng chat, chưa chèn output này, và ô đang trống. replace/append: CS chủ động bấm.
 */
export function decideInsert({ urlSession, cmd, composerText, insertedIds }) {
  if (!urlSession || cmd.session_id !== urlSession) return { status: "session_mismatch" };
  const current = String(composerText ?? "");
  if (cmd.mode === "replace") return { status: "inserted", text: cmd.text };
  if (cmd.mode === "append") return { status: "inserted", text: current.trim() ? `${current.replace(/\s+$/, "")}\n\n${cmd.text}` : cmd.text };
  if (insertedIds.has(cmd.output_id)) return { status: "duplicate" };
  if (current.trim()) return { status: "not_empty" };
  return { status: "inserted", text: cmd.text };
}

/** Chỉ nhận message copilot:* do chính trang này gửi. */
export function isCopilotMessage(ev, win) {
  return ev.source === win && typeof ev.data?.type === "string" && ev.data.type.startsWith("copilot:");
}

/**
 * Màu nền editor có phải tông VÀNG của Note mode không (Crisp chuyển ô soạn
 * sang nền vàng khi ở chế độ private note — bằng chứng từ Crisp thật
 * 2026-10-23). Nhận chuỗi computed style "rgb(r, g, b)"/"rgba(...)"; màu
 * trắng/xám/tối (Reply mode) phải trả false.
 */
export function isYellowishColor(css) {
  const m = String(css ?? "").match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return r >= 120 && g >= 95 && b <= r - 45 && g >= b + 25;
}

/** Tab chuyển mode (Reply/Note/…) có đang ở trạng thái active không, theo class/aria composer.js trích ra. */
export function tabLooksActive({ className = "", ariaSelected = null, dataState = "" } = {}) {
  if (ariaSelected === "true" || dataState === "active" || dataState === "selected") return true;
  return /(^|[\s_-])(active|selected|current|on)(?=$|[\s_-])/i.test(String(className));
}

/**
 * Cổng xác nhận Note mode trước khi điền private note — an toàn là trên hết:
 * BẮT BUỘC tab Note báo active VÀ có thêm ít nhất một tín hiệu phía editor
 * (nền vàng / class note / placeholder nhắc note). Chỉ một phía thì KHÔNG đủ
 * tin: composer huỷ và không điền gì cả, thà báo lỗi còn hơn điền nội dung
 * nội bộ vào ô Reply cho khách thấy.
 */
export function confirmNoteMode({ tabActive = false, yellowBg = false, noteClass = false, notePlaceholder = false } = {}) {
  return Boolean(tabActive) && Boolean(yellowBg || noteClass || notePlaceholder);
}
