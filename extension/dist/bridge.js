// Logic thuần của extension (không chạm DOM/chrome.*). Build gộp file này vào đầu từng content script.

/** "/inbox/session_xxx/" trong URL Crisp → "session_xxx". */
function sessionFromUrl(href) {
  const m = String(href).match(/\/(session_[\w-]+)/);
  return m ? m[1] : null;
}

/**
 * Quyết định chèn draft vào ô Reply (spec 6.4). Trả text cuối cùng cần có trong ô khi được chèn.
 * auto: chỉ chèn khi đúng chat, chưa chèn output này, và ô đang trống. replace/append: CS chủ động bấm.
 */
function decideInsert({ urlSession, cmd, composerText, insertedIds, lastFilledText }) {
  if (!urlSession || cmd.session_id !== urlSession) return { status: "session_mismatch" };
  const current = String(composerText ?? "");
  if (cmd.mode === "replace") return { status: "inserted", text: cmd.text };
  if (cmd.mode === "append") return { status: "inserted", text: current.trim() ? `${current.replace(/\s+$/, "")}\n\n${cmd.text}` : cmd.text };
  if (insertedIds.has(cmd.output_id)) return { status: "duplicate" };
  if (current.trim()) {
    // Ô còn NGUYÊN VĂN bản copilot tự điền lần trước (người chưa gõ/sửa
    // gì): thay bằng bản mới luôn, không hỏi "Thay thế toàn bộ" — câu hỏi
    // đó chỉ để bảo vệ chữ NGƯỜI tự gõ. Ethan bắt live 2026-10-26: điền
    // draft xong, soạn bản mới bấm Điền lại bị bắt xác nhận thay thế
    // chính bản copilot vừa điền, thừa và khó hiểu.
    if (lastFilledText && textsMatch(current, lastFilledText)) return { status: "inserted", text: cmd.text };
    return { status: "not_empty" };
  }
  return { status: "inserted", text: cmd.text };
}

/** Chỉ nhận message copilot:* do chính trang này gửi. */
function isCopilotMessage(ev, win) {
  return ev.source === win && typeof ev.data?.type === "string" && ev.data.type.startsWith("copilot:");
}

/**
 * Màu nền editor có phải tông VÀNG của Note mode không (Crisp chuyển ô soạn
 * sang nền vàng khi ở chế độ private note — bằng chứng từ Crisp thật
 * 2026-10-23; phiên dò DOM 2026-10-26 xác nhận trên giao diện tối đó là tông
 * vàng olive SẪM, không phải vàng sáng). Nhận chuỗi computed style
 * "rgb(r, g, b)"/"rgba(...)"; màu trắng/xám/tối-trung-tính/lạnh của Reply
 * mode phải trả false. Tiêu chí là độ ẤM (đỏ và xanh lá đều vượt xanh dương
 * một khoảng rõ), áp cho cả vàng sáng (theme sáng) lẫn olive sẫm (theme tối).
 */
function isYellowishColor(css) {
  const m = String(css ?? "").match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return r >= 35 && r >= g && r - b >= 20 && g - b >= 10;
}

/**
 * Nhận diện placeholder của ô soạn theo VĂN BẢN hiển thị thật (phiên dò
 * 2026-10-26 trên Crisp thật: placeholder là chữ render trong vùng soạn chứ
 * không nằm ở thuộc tính của editor — bản cũ đọc data-placeholder/aria-label
 * nên luôn trượt). "Send a private note…" = Note mode; "Send your message
 * to…" = Reply mode. Không khớp thì null.
 */
function placeholderKind(text) {
  const t = String(text ?? "").trim();
  if (/^send a private note/i.test(t)) return "note";
  if (/^send your message to/i.test(t)) return "reply";
  return null;
}

/** Tab chuyển mode (Reply/Note/…) có đang ở trạng thái active không, theo class/aria composer.js trích ra. */
function tabLooksActive({ className = "", ariaSelected = null, dataState = "" } = {}) {
  if (ariaSelected === "true" || dataState === "active" || dataState === "selected") return true;
  return /(^|[\s_-])(active|selected|current|on)(?=$|[\s_-])/i.test(String(className));
}

/**
 * Cổng xác nhận Note mode trước khi điền private note — an toàn là trên hết,
 * thà huỷ không điền còn hơn điền nội dung nội bộ vào ô Reply cho khách thấy.
 * Bằng chứng phiên dò 2026-10-26: class của tab trên Crisp thật là chuỗi băm
 * (không mang token active/selected) nên tabActive KHÔNG còn là điều kiện bắt
 * buộc như bản cũ — đó chính là gốc Lỗi 1 (điền Note không chạy trên máy
 * thật). Xác nhận đạt khi:
 * - tab Note báo active VÀ có ít nhất 1 tín hiệu phía editor; HOẶC
 * - có ít nhất 2 tín hiệu phía editor độc lập (nền vàng ấm / class note /
 *   placeholder "Send a private note…" / nhãn Note trong vùng soạn) — các tín
 *   hiệu này chỉ tồn tại ở Note mode, không thể xuất hiện ở ô Reply.
 */
function confirmNoteMode({ tabActive = false, yellowBg = false, noteClass = false, notePlaceholder = false, notePill = false } = {}) {
  const editorSignals = [yellowBg, noteClass, notePlaceholder, notePill].filter(Boolean).length;
  return (Boolean(tabActive) && editorSignals >= 1) || editorSignals >= 2;
}

/**
 * Kiểm chứng sau khi ghi: ô soạn phải chứa dòng đầu tiên (không rỗng) của nội
 * dung vừa ghi. Editor rich-text (Lexical) có thể nuốt sự kiện paste tổng hợp
 * mà không báo lỗi — không kiểm chứng thì extension báo "đã điền" trong khi ô
 * trống hoặc chữ rơi chỗ khác (gốc Lỗi 2: dán dính/không tách đoạn mà panel
 * không hề biết). Không khớp → caller báo insert_unverified thay vì inserted.
 */
function verifyWritten(readBack, text) {
  const line = String(text ?? "").split("\n").map((s) => s.trim()).find((s) => s.length > 0);
  if (!line) return false;
  return String(readBack ?? "").includes(line.slice(0, 60));
}

/**
 * Chuẩn hoá để so khớp TOÀN VĂN sau khi điền: bỏ ký tự zero-width, thống nhất
 * xuống dòng, cắt khoảng trắng cuối dòng, gộp nhiều dòng trống liên tiếp
 * thành một (Lexical render đoạn cách nhau bằng 1 hay 2 dấu xuống dòng tuỳ
 * ngữ cảnh — khác biệt đó không phải lỗi điền). KHÔNG nới tới mức nuốt được
 * nội dung trùng lặp: bản cũ còn nguyên + bản mới dán thêm vào (lỗi điền
 * "thay thế mà thành chèn thêm" Ethan gặp 2026-10-26) cho chuỗi dài gấp đôi,
 * so khớp toàn văn bắt được ngay, trong khi verifyWritten cũ chỉ thấy dòng
 * đầu tồn tại là cho qua.
 */
function normalizeComposerText(text) {
  return String(text ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Ô soạn sau khi điền phải khớp TOÀN VĂN kỳ vọng (đã chuẩn hoá hai phía). */
function textsMatch(readBack, expected) {
  const a = normalizeComposerText(readBack);
  const b = normalizeComposerText(expected);
  return b.length > 0 && a === b;
}

/**
 * Kiểm chứng điền theo kiểu GẬP KHOẢNG TRẮNG: mọi chuỗi khoảng trắng (kể cả
 * xuống dòng) gập thành một dấu cách trước khi so. Lý do cần thêm lớp này
 * bên cạnh textsMatch: innerText của editor Lexical nối các đoạn bằng \n
 * hay \n\n và có thể chèn ngắt dòng theo chiều rộng ô — khác biệt trình bày
 * đó từng làm textsMatch trượt, fillEditor điền LẠI lần hai chồng lên lần
 * một (nội dung gấp đôi trên bản live 2026-10-26). Gập khoảng trắng vẫn bắt
 * được gấp đôi thật: bản gấp đôi dài gấp hai và khác hẳn sau khi gập.
 */
function fillVerified(readBack, expected) {
  // Editor kiểu Lexical có thể biến dòng "1. ..." thành mục danh sách thật:
  // số thứ tự thành marker hiển thị, KHÔNG còn nằm trong innerText — bản
  // đọc lại thiếu đúng "1. " dù nội dung đã vào đủ (ca live 2026-10-26:
  // note handoff có dòng đánh số, chữ vào ô Note rồi mà xác nhận cứ
  // mismatch). Gọt marker đầu dòng ở CẢ hai phía trước khi so.
  const stripMarkers = (s) => String(s ?? "").split("\n").map((l) => l.replace(/^\s*(?:\d{1,3}[.)]|[-•*])\s+/, "")).join("\n");
  const squash = (s) => normalizeComposerText(stripMarkers(s)).replace(/\s+/g, " ").trim();
  const a = squash(readBack);
  const b = squash(expected);
  if (!b) return false;
  if (a === b) return true;
  // Dung sai HẸP cho khác biệt render chưa lường hết: mọi dòng kỳ vọng đủ
  // dài đều phải có mặt trong bản đọc lại và tổng độ dài không lệch quá
  // 3% (tối thiểu 6 ký tự). Thiếu đoạn, thừa đoạn hay gấp đôi nội dung
  // vẫn bị bắt như cũ.
  const lines = normalizeComposerText(stripMarkers(expected)).split("\n")
    .map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length >= 12);
  return lines.length > 0 && lines.every((l) => a.includes(l))
    && Math.abs(a.length - b.length) <= Math.max(6, Math.round(b.length * 0.03));
}

/**
 * Vết chẩn đoán gọn của một lần điền (panel hiện kèm thông báo lỗi để lần
 * test live nào lỗi là thấy ngay khâu nào, khỏi đoán): tín hiệu Note mode
 * dạng tab/yel/cls/ph/pil kèm 0/1.
 */
function signalTrace(signals = {}) {
  const bit = (v) => (v ? "1" : "0");
  return `tab${bit(signals.tabActive)} yel${bit(signals.yellowBg)} cls${bit(signals.noteClass)} ph${bit(signals.notePlaceholder)} pil${bit(signals.notePill)}`;
}


// Chạy trong iframe widget (domain Netlify). Cầu nối window.postMessage ↔ chrome.runtime.
const WIDGET_ORIGIN = "https://copilot-oe.netlify.app";
const PROTOCOL = 2; // 2: thêm target "note" cho copilot:insert — widget cũ hiểu là outdated để khỏi điền note vào ô Reply

window.addEventListener("message", (ev) => {
  if (ev.origin !== WIDGET_ORIGIN || !isCopilotMessage(ev, window)) return;
  const m = ev.data;
  if (m.type === "copilot:ping") {
    // Kèm mã định danh của CHÍNH bản cài này (chrome.runtime.id): widget gom
    // mọi pong trong cửa sổ ping — hai mã khác nhau = hai bản extension đang
    // chạy song song trong cùng Chrome (bản cũ chưa gỡ), mỗi lệnh điền bị cả
    // hai cùng thực thi (ca live 2026-10-26: nội dung gấp đôi, note lỗi).
    window.postMessage({ type: "copilot:pong", protocol: PROTOCOL, version: chrome.runtime.getManifest().version, ext: chrome.runtime.id ?? "" }, WIDGET_ORIGIN);
  } else if (m.type === "copilot:insert") {
    chrome.runtime.sendMessage(m, (res) => {
      const fallback = { type: "copilot:insert_result", request_id: m.request_id, status: "composer_not_found" };
      window.postMessage(chrome.runtime.lastError || !res ? fallback : res, WIDGET_ORIGIN);
    });
  }
});
