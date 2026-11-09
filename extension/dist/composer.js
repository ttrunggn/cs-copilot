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
    // đó chỉ để bảo vệ chữ NGƯỜI tự gõ; hỏi xác nhận thay thế chính bản
    // copilot vừa điền là thừa và khó hiểu.
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
 * sang nền vàng khi ở chế độ private note ; trên giao diện tối
 * đó là tông vàng olive SẪM, không phải vàng sáng). Nhận chuỗi computed style
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
 * Nhận diện placeholder của ô soạn theo VĂN BẢN hiển thị (trên Crisp
 * placeholder là chữ render trong vùng soạn chứ không nằm ở thuộc tính của
 * editor — đọc data-placeholder/aria-label sẽ luôn trượt). "Send a private note…" = Note mode; "Send your message
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
 * Class của tab trên Crisp là chuỗi băm (không mang token active/selected)
 * nên tabActive KHÔNG phải điều kiện bắt buộc (bắt buộc thì điền Note không
 * bao giờ chạy). Xác nhận đạt khi:
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
 * trống hoặc chữ rơi chỗ khác (dán dính/không tách đoạn mà panel
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
 * "thay thế mà thành chèn thêm") cho chuỗi dài gấp đôi, so khớp toàn văn
 * bắt được ngay, trong khi verifyWritten chỉ thấy dòng đầu tồn tại là cho qua.
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
 * đó làm textsMatch trượt, fillEditor sẽ điền LẠI lần hai chồng lên lần
 * một (nội dung gấp đôi). Gập khoảng trắng vẫn bắt
 * được gấp đôi thật: bản gấp đôi dài gấp hai và khác hẳn sau khi gập.
 */
function fillVerified(readBack, expected) {
  // Editor kiểu Lexical có thể biến dòng "1. ..." thành mục danh sách thật:
  // số thứ tự thành marker hiển thị, KHÔNG còn nằm trong innerText — bản
  // đọc lại thiếu đúng "1. " dù nội dung đã vào đủ (vd note handoff có
  // dòng đánh số). Gọt marker đầu dòng ở CẢ hai phía trước khi so.
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
 * Vết chẩn đoán gọn của một lần điền (panel hiện kèm thông báo lỗi để
 * thấy ngay khâu nào lỗi, khỏi đoán): tín hiệu Note mode
 * dạng tab/yel/cls/ph/pil kèm 0/1.
 */
function signalTrace(signals = {}) {
  const bit = (v) => (v ? "1" : "0");
  return `tab${bit(signals.tabActive)} yel${bit(signals.yellowBg)} cls${bit(signals.noteClass)} ph${bit(signals.notePlaceholder)} pil${bit(signals.notePill)}`;
}

/**
 * Tên truy cập của một phần tử: aria-label → title → text, chuẩn hoá
 * (trim, gộp khoảng trắng, chữ thường) để so khớp nhãn nút của Crisp
 * mà không phụ thuộc hoa/thường hay khoảng trắng thừa.
 */
function accessibleName(el) {
  const raw = el?.getAttribute?.("aria-label") ?? el?.getAttribute?.("title") ?? el?.textContent ?? "";
  return String(raw).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Đúng iframe widget của copilot: thẻ IFRAME và src bắt đầu bằng origin của widget. */
function isWidgetIframe(el, origin) {
  if (!el || String(el.tagName ?? "").toUpperCase() !== "IFRAME" || !origin) return false;
  return String(el.getAttribute?.("src") ?? "").startsWith(origin);
}

/** session_id trong query của src iframe widget (Crisp gắn sẵn); không có → null. */
function widgetSessionFromSrc(src) {
  const m = String(src ?? "").match(/[?&]session_id=([^&#]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * Class của nút Expand trên DOM Crisp: nút KHÔNG phải <button> và không mang nhãn chữ
 * nào — nó là span.c-conversation-profile-widget__expand (trong có svg
 * .c-conversation-profile-widget__expand-icon), nằm ở chân hộp widget.
 * Chỉ tìm <button> tên "expand" thì không bao giờ thấy nó. Giữ nhánh <button>
 * tên "expand" làm đường dự phòng nếu Crisp đổi lại markup.
 */
const EXPAND_CONTROL_CLASS = "c-conversation-profile-widget__expand";

/** Phần tử có mang class này không (đọc qua getAttribute để đúng cả SVG). */
function elHasClass(el, cls) {
  const raw = el?.getAttribute?.("class") ?? (typeof el?.className === "string" ? el.className : "");
  return String(raw).split(/\s+/).includes(cls);
}

/**
 * Nút Expand của hộp widget: leo tổ tiên của iframe, mỗi tầng gom ứng viên
 * trong phạm vi đó (ưu tiên span Expand theo class Crisp, rồi <button> tên
 * "expand"). Tầng HẸP nhất có ứng viên quyết định: đúng 1 → trả về; nhiều
 * hơn 1 → null (mơ hồ, không bấm đoán); không có → leo tiếp, tối đa
 * maxLevels tầng. Leo dừng ngay khi phạm vi chứa thêm một iframe khác (đã
 * ra khỏi hộp của mình, sang container chung của sidebar) — nút Expand của
 * hộp plugin khác vì thế không lọt.
 */
function findExpandButton(iframe, maxLevels = 8) {
  let scope = iframe ?? null;
  for (let level = 0; level < maxLevels && scope; level++) {
    scope = scope.parentElement ?? null;
    if (!scope) break;
    // Phạm vi chứa thêm iframe khác = đã ra khỏi hộp của mình (container
    // chung của sidebar) — dừng ngay, không xét nút ở phạm vi đó.
    const frames = [...(scope.querySelectorAll?.("iframe") ?? [])]
      .filter((el) => String(el?.tagName ?? "").toUpperCase() === "IFRAME");
    if (frames.length > 1) return null;
    const spans = [...(scope.querySelectorAll?.("span") ?? [])]
      .filter((el) => String(el?.tagName ?? "").toUpperCase() === "SPAN" && elHasClass(el, EXPAND_CONTROL_CLASS));
    if (spans.length === 1) return spans[0];
    if (spans.length > 1) return null;
    const buttons = [...(scope.querySelectorAll?.("button") ?? [])]
      .filter((el) => String(el?.tagName ?? "").toUpperCase() === "BUTTON" && accessibleName(el) === "expand");
    if (buttons.length === 1) return buttons[0];
    if (buttons.length > 1) return null;
  }
  return null;
}

/**
 * Nút Expand có THẬT SỰ bấm được lúc này không. Đo trên Crisp cả hai trạng thái:
 * khi hộp mở rộng, span và icon KHÔNG đổi class, KHÔNG đổi
 * vị trí — khác biệt duy nhất là iframe của widget phủ lên đúng tâm icon,
 * nên elementFromPoint tại tâm nút trả iframe thay vì svg. Còn bấm được =
 * rect có kích thước và phần tử trên cùng tại tâm nút là chính nút hoặc
 * con của nó. Thiếu API đo (môi trường test) thì coi như bấm được.
 */
function isExpandActionable(el) {
  if (!el) return false;
  const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
  if (!rect) return true;
  if (rect.width <= 0 || rect.height <= 0) return false;
  const doc = el.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  if (!doc || typeof doc.elementFromPoint !== "function") return true;
  const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!hit) return true;
  return hit === el || (typeof el.contains === "function" && el.contains(hit));
}

/**
 * Bấm nút Expand: phát chuỗi mousedown/mouseup/click nổi bọt từ phần tử
 * sâu nhất (svg icon trong span) — cách bấm mở được hộp trên Crisp. Môi trường không có MouseEvent
 * hoặc không dispatchEvent được thì rơi xuống .click().
 */
function activateControl(el) {
  if (!el) return;
  const target = [...(el.querySelectorAll?.("svg") ?? [])][0] ?? el;
  try {
    if (typeof target.dispatchEvent === "function" && typeof MouseEvent !== "undefined") {
      const rect = typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
      const opts = {
        bubbles: true,
        cancelable: true,
        clientX: rect ? rect.left + rect.width / 2 : 0,
        clientY: rect ? rect.top + rect.height / 2 : 0,
      };
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.dispatchEvent(new MouseEvent("click", opts));
      return;
    }
  } catch { /* rơi xuống .click() bên dưới */ }
  target.click?.();
}

/**
 * Máy trạng thái tự mở rộng, theo từng phiên chat. "Thấy nút" ở đây là
 * nút còn BẤM ĐƯỢC (isExpandActionable): trên Crisp nút không biến
 * mất khi hộp mở mà bị iframe phủ lên, nên tín hiệu mở/đóng là tính bấm
 * được chứ không phải sự tồn tại trong DOM.
 * - Thấy nút bấm được ở phiên chưa từng bấm → bấm (observe trả true).
 * - Sau khi bấm, nút không còn bấm được (lớp phủ đã mở) từ 2 lần quan sát
 *   liên tiếp → coi như ĐÃ MỞ. Lớp phủ mang sang từ phiên trước cũng vào
 *   trạng thái này (vào phiên mới mà 2 lần liền nút không bấm được).
 * - ĐÃ MỞ mà nút bấm được trở lại = người dùng vừa bấm Close → phiên đó
 *   không bao giờ tự mở lại nữa (không giành nhau với người dùng).
 * - Bấm xong mà nút vẫn bấm được sau 6 lần quan sát (lần bấm trượt)
 *   → cho bấm lại.
 */
function createExpandTracker() {
  let session = null;
  let clicked = false;
  let absentStreak = 0;
  let expanded = false;
  let closedByUser = false;
  let stuck = 0;
  return {
    observe(nextSession, buttonPresent) {
      if (nextSession !== session) {
        session = nextSession;
        clicked = false;
        absentStreak = 0;
        expanded = false;
        closedByUser = false;
        stuck = 0;
      }
      if (closedByUser) return false;
      if (!buttonPresent) {
        absentStreak++;
        if (absentStreak >= 2) expanded = true;
        return false;
      }
      absentStreak = 0;
      if (expanded) {
        closedByUser = true;
        return false;
      }
      if (clicked) {
        stuck++;
        if (stuck >= 6) {
          clicked = false;
          stuck = 0;
          return true;
        }
        return false;
      }
      return true;
    },
    noteClicked() {
      clicked = true;
      stuck = 0;
    },
  };
}


// Chạy ở top frame app.crisp.chat: tìm ô soạn và chèn nội dung như người gõ để editor của Crisp nhận.
// Hai đích: ô Reply (draft/review, mặc định) và ô Note (private note — msg.target === "note").
// Note là nội dung nội bộ: chỉ điền khi ĐÃ XÁC NHẬN đang ở Note mode (xem
// confirmNoteMode ở composer-core), không xác nhận được thì huỷ, không điền gì cả.
// Mọi lần điền đều để lại "trace" — vết chẩn đoán gọn trả kèm kết quả để panel
// hiện trong thông báo lỗi: lỗi ở khâu nào là thấy ngay
// (tín hiệu Note, xoá, ghi, khớp) thay vì đoán.
const COMPOSER_SELECTORS = [
  // Trên app.crisp.chat: ô Reply là editor Lexical (contenteditable). Thứ tự = ưu tiên.
  ".c-conversation-box-field__field-composer-field",
  ".c-conversation-box-field [contenteditable='true']",
  "[data-placeholder] [contenteditable='true']",
  "textarea[name='message']",
  "div[contenteditable='true'][role='textbox']",
];
const inserted = new Set();
// Văn bản copilot tự điền gần nhất theo đích (reply/note) TRONG trang này:
// ô soạn còn nguyên văn bản đó nghĩa là người chưa gõ/sửa gì — lần điền
// sau thay luôn không cần hỏi (xem decideInsert).
const lastFilled = { reply: "", note: "" };

function visible(el) {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;
  // Editor của mode không active có thể vẫn còn trong DOM với kích thước > 0
  // (Crisp giữ cả hai editor) — loại thêm theo computed style để khỏi chọn
  // nhầm ô của mode kia.
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden";
}

function findComposer() {
  for (const sel of COMPOSER_SELECTORS) {
    const el = [...document.querySelectorAll(sel)].find(visible);
    if (el) return el;
  }
  return null;
}

/** MỌI phần tử ứng viên ô soạn (mọi selector, khử trùng, giữ thứ tự ưu tiên). */
function findComposers() {
  const out = [];
  for (const sel of COMPOSER_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      if (visible(el) && !out.includes(el)) out.push(el);
    }
  }
  return out;
}

function readText(el) {
  const raw = el.tagName === "TEXTAREA" ? el.value : el.innerText;
  // Editor rich-text hay giữ ký tự zero-width trong ô "trống" — bỏ đi để
  // quyết định ô trống/có chữ (decideInsert) không bị đánh lừa.
  return String(raw ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "");
}

/**
 * Phần tử contenteditable THẬT bên trong phần tử selector khớp: selector đầu
 * có thể trúng wrapper của editor — sự kiện paste/focus phải rơi đúng vào
 * contenteditable, rơi vào wrapper thì Lexical không nhận (sự kiện chỉ nổi
 * lên trên, không chìm xuống con). Không có contenteditable con thì dùng
 * chính phần tử đã khớp.
 */
function editableOf(el) {
  if (!el || el.tagName === "TEXTAREA") return el;
  if (el.getAttribute?.("contenteditable") === "true") return el;
  if (typeof el.querySelectorAll === "function") {
    for (const kid of el.querySelectorAll("[contenteditable]")) {
      if (kid.getAttribute?.("contenteditable") === "true" && visible(kid)) return kid;
    }
  }
  return el;
}

function selectAll(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Xoá SẠCH ô soạn và kiểm chứng rỗng thật. Chỉ bắn MỘT beforeinput
 * deleteContentBackward tổng hợp là không đủ — Lexical nuốt sự kiện đó mà
 * không xoá, nên bước paste sau đó dán bản mới LÊN TRÊN bản cũ: "thay thế"
 * thành chèn thêm, nội dung lặp 2-3 lần. Vì vậy thử lần lượt:
 * execCommand("delete") trên vùng chọn toàn bộ → phím Backspace → beforeinput
 * → xoá node qua Selection API; cách nào làm ô rỗng thật mới tính là xong.
 * Bước xoá DOM thẳng phải CHỜ rồi đọc lại: Lexical có thể dựng lại nội dung
 * cũ từ state của nó ngay sau khi DOM bị đụng vào — đọc ngay thấy rỗng giả,
 * dán tiếp là gấp đôi.
 */
async function clearEditor(el, trace) {
  if (!readText(el).trim()) { trace?.push("clr:empty"); return true; }
  const gone = () => !readText(el).trim();
  // Mỗi cách xoá phải được xác nhận SAU một nhịp chờ mới tin: editor có thể
  // "dựng lại" nội dung cũ từ state riêng của nó ngay sau khi DOM bị xoá
  // thẳng — đọc ngay lập tức thấy rỗng giả, tưởng đã sạch mà dán tiếp là
  // gấp đôi.
  const confirmGone = async (how) => {
    if (!gone()) return false;
    await delay(55);
    if (!gone()) return false;
    trace?.push(how);
    return true;
  };
  selectAll(el);
  document.execCommand("delete", false, null);
  if (await confirmGone("clr:exec")) return true;
  selectAll(el);
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", bubbles: true }));
  if (await confirmGone("clr:key")) return true;
  selectAll(el);
  el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
  if (await confirmGone("clr:bi")) return true;
  const sel = getSelection();
  if (sel && sel.rangeCount) {
    selectAll(el);
    sel.getRangeAt(0).deleteContents();
  }
  const ok = await confirmGone("clr:dom");
  if (!ok) trace?.push("clr:fail");
  return ok;
}

// Lexical bỏ xuống dòng khi dùng insertText, nhưng nhận paste thành từng đoạn.
function writeText(el, text) {
  if (el.tagName === "TEXTAREA") {
    el.focus();
    el.select();
    document.execCommand("insertText", false, text);
    return;
  }
  el.focus();
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const handled = !el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  if (!handled) document.execCommand("insertText", false, text);
}

/**
 * Điền = THAY TOÀN BỘ ô soạn bằng text kỳ vọng (decideInsert đã tính sẵn
 * text cuối cùng cho cả replace lẫn append). Xoá không sạch thì DỪNG, không
 * dán chồng lên bản cũ. Sau khi dán, chờ editor settle rồi so khớp theo
 * fillVerified (gập khoảng trắng — innerText của Lexical nối đoạn bằng \n
 * hay \n\n tuỳ render, khác biệt trình bày đó không phải lỗi điền); lệch
 * thì tìm lại editor (Crisp có thể đã thay node) và điền lại đúng một lần.
 */
async function fillEditor(el, text, trace, refind) {
  if (el.tagName === "TEXTAREA") {
    writeText(el, text);
    return fillVerified(readText(el), text);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const node = editableOf(attempt === 0 || !refind ? el : (refind() ?? el));
    if (!(await clearEditor(node, trace))) return false;
    writeText(node, text);
    await delay(60);
    const ok = fillVerified(readText(node), text);
    trace?.push(`a${attempt + 1}:${ok ? "ok" : "mismatch"}(${readText(node).length})`);
    if (ok) return true;
  }
  return false;
}

// ---------- chuyển sang Note mode ----------
// Thanh công cụ ô soạn Crisp có các tab Reply | Edit | Note | Reminder |
// Shortcuts | Knowledge Base — Note là
// một tab bấm được ngay cạnh Reply. Tab được tìm TRONG vùng ô soạn (leo từ
// editor lên), không tìm toàn trang để khỏi khớp nhầm chữ "Note" trong nội
// dung tin nhắn; phần tử nằm trong chính editor cũng bị loại (CS có thể đang
// gõ chữ "Note" trong ô soạn).

function classOf(el) {
  return el?.getAttribute?.("class") ?? "";
}

function findTabIn(scope, editor, label) {
  // Ưu tiên thuộc tính khai báo mode/tab rõ ràng.
  for (const el of scope.querySelectorAll("[data-mode], [data-tab], [aria-label]")) {
    if (editor.contains(el) || !visible(el)) continue;
    const v = (el.getAttribute("data-mode") || el.getAttribute("data-tab") || el.getAttribute("aria-label") || "").trim();
    if (v.toLowerCase() === label.toLowerCase()) return el;
  }
  // Sau đó mới tới lá văn bản khớp đúng nhãn, và lá phải bấm được (nằm trong
  // nút/tab thật hoặc có cursor pointer) để không khớp chữ trong nội dung khác.
  for (const el of scope.querySelectorAll("button, a, [role='tab'], [role='button'], div, span")) {
    if (el.children.length || editor.contains(el) || !visible(el)) continue;
    if (el.textContent.trim() !== label) continue;
    const click = el.closest("button, a, [role='tab'], [role='button']");
    if (click) return click;
    if (getComputedStyle(el).cursor === "pointer") return el;
  }
  return null;
}

function findModeTab(editor, label) {
  let scope = editor;
  for (let i = 0; i < 10 && scope; i++) {
    const tab = findTabIn(scope, editor, label);
    if (tab) return tab;
    scope = scope.parentElement;
  }
  return null;
}

/**
 * Phạm vi gom tín hiệu Note mode: leo từ editor lên (tối đa 8 tầng) tới
 * container chứa CẢ thanh tab (có lá "Reply" và lá "Note"). Không dừng ở
 * .c-conversation-box-field: trên Crisp, phần "trang trí" của Note mode (nền
 * vàng phủ cả hàng tab, pill "Note", placeholder) nằm ở container composer
 * PHÍA TRÊN box-field, dừng sớm thì tín hiệu không bao giờ lọt vào phạm vi
 * và cổng xác nhận không qua nổi dù CS đã mở sẵn tab Note.
 */
function signalScope(editor) {
  let root = editor;
  for (let i = 0; i < 8 && root.parentElement; i++) {
    root = root.parentElement;
    let hasReply = false;
    let hasNote = false;
    for (const el of root.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (t === "Reply") hasReply = true;
      if (t === "Note") hasNote = true;
    }
    if (hasReply && hasNote) break;
  }
  return root;
}

/** Gom các tín hiệu Note mode tại thời điểm gọi (editor có thể bị Crisp thay node khi chuyển mode). */
function collectNoteSignals(editor) {
  const root = signalScope(editor);
  const tab = findModeTab(editor, "Note");
  // Leo từ EDITOR THẬT (contenteditable), không phải từ phần tử selector
  // khớp: selector đầu có thể trúng WRAPPER bọc ngoài editor, mà nền vàng
  // của Note mode nằm ngay trên chính contenteditable / lớp bọc trong của
  // nó — leo từ wrapper đi lên thì không bao giờ chạm được lớp đó (trace
  // sẽ ra yel0 dù editor nền vàng rõ ràng).
  const start = editableOf(editor) ?? editor;
  let yellowBg = false;
  let noteClass = false;
  for (let node = start; node; node = node.parentElement) {
    if (/(^|[\s_-])note(?=$|[\s_-])/i.test(classOf(node))) noteClass = true;
    if (!yellowBg) yellowBg = isYellowishColor(getComputedStyle(node).backgroundColor);
    if (node === root) break;
  }
  // Nền vàng có thể phủ ở container NGOÀI phạm vi tín hiệu đúng một tầng
  // (phủ cả hàng tab) — kiểm thêm đúng một tầng đó.
  if (!yellowBg && root.parentElement) {
    yellowBg = isYellowishColor(getComputedStyle(root.parentElement).backgroundColor);
    if (!noteClass) noteClass = /(^|[\s_-])note(?=$|[\s_-])/i.test(classOf(root.parentElement));
  }
  const attrPh = start.getAttribute?.("data-placeholder")
    ?? start.closest?.("[data-placeholder]")?.getAttribute("data-placeholder")
    ?? start.getAttribute?.("aria-label")
    ?? editor.getAttribute("data-placeholder")
    ?? "";
  // Placeholder trên Crisp là CHỮ RENDER quanh editor ("Send a private
  // note to your team…" / "Send your message to … in chat…"), không nằm ở thuộc tính — đọc cả hai đường, thuộc tính chỉ là
  // dự phòng. Quét MỌI lá trong phạm vi tín hiệu: thấy placeholder Note ở
  // bất cứ đâu là tính Note (placeholder Reply cũ còn sót trong DOM không
  // được phủ quyết). Nhãn "Note" dạng pill ở đầu dòng soạn cũng là tín hiệu
  // riêng; lá thuộc thanh tab (chính tab Note hoặc cùng hàng tab) bị loại
  // để không tính trùng — pill nằm ở hàng soạn, không ở hàng tab.
  let phKind = placeholderKind(attrPh) ?? (/note/i.test(attrPh) ? "note" : null);
  let sawNotePh = phKind === "note";
  let notePill = false;
  const tabBar = tab?.parentElement ?? null;
  for (const el of root.querySelectorAll("*")) {
    // Bỏ qua lá nằm TRONG editor thật (đó là chữ người dùng gõ); lá trong
    // wrapper nhưng ngoài editor (pill "Note" ở mép ô soạn) vẫn tính.
    if (el === start || start.contains(el) || el.children.length) continue;
    const t = (el.textContent || "").trim();
    if (!t) continue;
    const k = placeholderKind(t);
    if (k === "note") sawNotePh = true;
    else if (k && !phKind) phKind = k;
    if (t === "Note" && tab !== el && !tab?.contains(el) && !(tabBar && tabBar.contains(el))) notePill = true;
  }
  if (sawNotePh) phKind = "note";
  return {
    tab,
    signals: {
      tabActive: tab ? tabLooksActive({ className: classOf(tab), ariaSelected: tab.getAttribute("aria-selected") ?? tab.getAttribute("aria-pressed"), dataState: tab.getAttribute("data-state") ?? "" }) : false,
      yellowBg,
      noteClass,
      notePlaceholder: phKind === "note",
      notePill,
    },
  };
}

/**
 * Chọn ứng viên editor cho đích Note: Crisp có thể giữ NHIỀU editor trong
 * DOM cùng lúc (cả hai mode) và selector đầu tiên không phân biệt mode —
 * chỉ chấm ứng viên đầu tiên thì nếu đó là editor của mode kia, mọi tín hiệu
 * đọc về 0 dù Note mode đang bật đúng. Vì vậy chấm TỪNG ứng viên: lấy ứng
 * viên đầu tiên qua cổng xác nhận; không ai qua thì lấy ứng viên nhiều tín
 * hiệu editor nhất (phục vụ trace + bấm tab chuyển mode).
 */
function pickNoteEditor() {
  let best = null;
  for (const editor of findComposers()) {
    const got = collectNoteSignals(editor);
    const n = [got.signals.yellowBg, got.signals.noteClass, got.signals.notePlaceholder, got.signals.notePill].filter(Boolean).length;
    if (!best || n > best.n) best = { editor, tab: got.tab, signals: got.signals, n };
    if (confirmNoteMode(got.signals)) break;
  }
  return best;
}

/**
 * Điền private note vào ô Note: bấm tab Note → chờ + xác nhận Note mode bằng
 * confirmNoteMode → kiểm tra lại lần cuối ngay trước khi ghi. Bất kỳ bước nào
 * không chắc chắn đều trả "note_unconfirmed" và KHÔNG ghi ký tự nào.
 */
async function insertIntoNote(msg, reply) {
  const trace = [];
  let pick = pickNoteEditor();
  if (!pick) return reply("composer_not_found", trace);
  trace.push(`sig0 ${signalTrace(pick.signals)}`);
  // Tín hiệu phía editor là quyết định chính (đúng thiết kế cổng v2); tab
  // chỉ dùng để BẤM CHUYỂN mode khi tín hiệu chưa đạt.
  if (!confirmNoteMode(pick.signals) && pick.tab) {
    pick.tab.click();
    trace.push("click");
    // Chuyển mode là bất đồng bộ (Crisp thay node editor/nền): chờ tối đa ~1s.
    for (let i = 0; i < 12; i++) {
      await delay(80);
      const next = pickNoteEditor();
      if (!next) continue;
      pick = next;
      if (confirmNoteMode(pick.signals)) break;
    }
  }
  pick = pickNoteEditor() ?? pick;
  trace.push(`sig1 ${signalTrace(pick.signals)}`);
  if (!confirmNoteMode(pick.signals)) return reply("note_unconfirmed", trace);
  const editor = pick.editor;
  const d = decideInsert({ urlSession: sessionFromUrl(location.href), cmd: msg, composerText: readText(editor), insertedIds: inserted, lastFilledText: lastFilled.note });
  if (d.status !== "inserted") return reply(d.status, trace);
  // Điền và kiểm chứng TOÀN VĂN: lệch là báo insert_unverified, không báo
  // inserted giả (xem fillEditor). Crisp có thể thay node khi điền → refind
  // lấy lại đúng ứng viên Note đang xác nhận được.
  if (!(await fillEditor(editor, d.text, trace, () => pickNoteEditor()?.editor ?? null))) return reply("insert_unverified", trace);
  inserted.add(msg.output_id);
  lastFilled.note = d.text;
  reply("inserted", trace);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "copilot:insert") return;
  const reply = (status, trace) => sendResponse({ type: "copilot:insert_result", request_id: msg.request_id, status, ...(trace?.length ? { trace } : {}) });
  if (msg.target === "note") {
    insertIntoNote(msg, reply).catch(() => reply("note_unconfirmed"));
    return true; // trả lời bất đồng bộ — giữ kênh sendResponse
  }
  (async () => {
    const trace = [];
    const el = findComposer();
    if (!el) return reply("composer_not_found", trace);
    const d = decideInsert({ urlSession: sessionFromUrl(location.href), cmd: msg, composerText: readText(el), insertedIds: inserted, lastFilledText: lastFilled.reply });
    if (d.status !== "inserted") return reply(d.status, trace);
    if (!(await fillEditor(el, d.text, trace, findComposer))) return reply("insert_unverified", trace);
    inserted.add(msg.output_id);
    lastFilled.reply = d.text;
    reply("inserted", trace);
  })().catch(() => reply("insert_unverified"));
  return true;
});

// ─── Tự mở rộng hộp Copilot CS ─────────────────────────────────────────────
// Hộp widget trong sidebar bị Crisp cắt ở ~330px, muốn xem hết phải bấm
// nút Expand ở đáy hộp. Extension tự bấm thay người: một lần cho mỗi
// phiên chat, và tôn trọng lần đóng tay của CS (xem createExpandTracker
// ở composer-core). Chỉ là thao tác giao diện của chính trang Crisp —
// không gọi mạng, không lưu dữ liệu.
// DOM Crisp: nút là span.c-conversation-
// profile-widget__expand chứ không phải <button> "Expand"; "thấy nút" với tracker là nút còn BẤM ĐƯỢC (isExpandActionable)
// vì khi hộp đã mở, span vẫn nằm trong DOM nhưng bị iframe phủ lên.
const WIDGET_ORIGIN = "https://copilot-oe.netlify.app";
const expandTracker = createExpandTracker();

function autoExpandTick() {
  try {
    const frame = [...document.querySelectorAll("iframe")].find((el) => isWidgetIframe(el, WIDGET_ORIGIN));
    if (!frame) return;
    const session = widgetSessionFromSrc(frame.getAttribute("src") ?? "") ?? "unknown";
    const control = findExpandButton(frame);
    const present = control ? isExpandActionable(control) : false;
    if (expandTracker.observe(session, present) && control) {
      activateControl(control);
      expandTracker.noteClicked();
    }
  } catch { /* lỗi ở tính năng phụ này không bao giờ được ảnh hưởng trang Crisp */ }
}

// Chỉ khởi động khi có MutationObserver (trình duyệt thật luôn có): môi
// trường test nạp bundle bằng document giả không có API này thì bỏ qua hẳn.
if (typeof MutationObserver !== "undefined") {
  try {
    new MutationObserver(() => autoExpandTick()).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(autoExpandTick, 5000);
    autoExpandTick();
  } catch { /* bỏ qua */ }
}
