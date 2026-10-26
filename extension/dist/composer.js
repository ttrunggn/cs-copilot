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
function decideInsert({ urlSession, cmd, composerText, insertedIds }) {
  if (!urlSession || cmd.session_id !== urlSession) return { status: "session_mismatch" };
  const current = String(composerText ?? "");
  if (cmd.mode === "replace") return { status: "inserted", text: cmd.text };
  if (cmd.mode === "append") return { status: "inserted", text: current.trim() ? `${current.replace(/\s+$/, "")}\n\n${cmd.text}` : cmd.text };
  if (insertedIds.has(cmd.output_id)) return { status: "duplicate" };
  if (current.trim()) return { status: "not_empty" };
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


// Chạy ở top frame app.crisp.chat: tìm ô soạn và chèn nội dung như người gõ để editor của Crisp nhận.
// Hai đích: ô Reply (draft/review, mặc định) và ô Note (private note — msg.target === "note").
// Note là nội dung nội bộ: chỉ điền khi ĐÃ XÁC NHẬN đang ở Note mode (xem
// confirmNoteMode ở composer-core), không xác nhận được thì huỷ, không điền gì cả.
const COMPOSER_SELECTORS = [
  // Dò trên app.crisp.chat thật 2026-10-19: ô Reply là editor Lexical (contenteditable). Thứ tự = ưu tiên.
  ".c-conversation-box-field__field-composer-field",
  ".c-conversation-box-field [contenteditable='true']",
  "[data-placeholder] [contenteditable='true']",
  "textarea[name='message']",
  "div[contenteditable='true'][role='textbox']",
];
const inserted = new Set();

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

function readText(el) {
  const raw = el.tagName === "TEXTAREA" ? el.value : el.innerText;
  // Editor rich-text hay giữ ký tự zero-width trong ô "trống" — bỏ đi để
  // quyết định ô trống/có chữ (decideInsert) không bị đánh lừa.
  return String(raw ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function selectAll(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Xoá SẠCH ô soạn và kiểm chứng rỗng thật. Bản cũ chỉ bắn MỘT beforeinput
 * deleteContentBackward tổng hợp — Lexical nuốt sự kiện đó mà không xoá, nên
 * bước paste sau đó dán bản mới LÊN TRÊN bản cũ: "thay thế" thành chèn thêm,
 * nội dung lặp 2-3 lần (Ethan test live 2026-10-26). Nay thử lần lượt:
 * execCommand("delete") trên vùng chọn toàn bộ → beforeinput → xoá node qua
 * Selection API; cách nào làm ô rỗng thật mới tính là xong.
 */
function clearEditor(el) {
  if (!readText(el).trim()) return true;
  selectAll(el);
  document.execCommand("delete", false, null);
  if (!readText(el).trim()) return true;
  selectAll(el);
  el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
  if (!readText(el).trim()) return true;
  const sel = getSelection();
  if (sel && sel.rangeCount) {
    selectAll(el);
    sel.getRangeAt(0).deleteContents();
  }
  return !readText(el).trim();
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
 * dán chồng lên bản cũ. Sau khi dán, so khớp toàn văn (textsMatch); lệch thì
 * xoá và điền lại đúng một lần nữa trước khi chịu thua.
 */
function fillEditor(el, text) {
  if (el.tagName === "TEXTAREA") {
    writeText(el, text);
    return textsMatch(readText(el), text);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    // Không xoá sạch được thì dừng ngay: dán chồng lên bản cũ còn tệ hơn
    // không điền (panel sẽ báo insert_unverified để CS biết).
    if (!clearEditor(el)) return false;
    writeText(el, text);
    if (textsMatch(readText(el), text)) return true;
  }
  return false;
}

// ---------- chuyển sang Note mode ----------
// Thanh công cụ ô soạn Crisp có các tab Reply | Edit | Note | Reminder |
// Shortcuts | Knowledge Base (bằng chứng: ảnh Crisp thật 2026-10-23) — Note là
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

/** Các lá văn bản quanh editor trong vùng soạn (ngoài chính editor), leo tối đa maxClimb tầng tổ tiên. */
function fieldLeaves(editor, maxClimb = 6) {
  const out = [];
  let scope = editor.parentElement;
  for (let i = 0; i < maxClimb && scope; i++) {
    for (const el of scope.querySelectorAll("*")) {
      if (el === editor || editor.contains(el)) continue;
      if (el.children.length === 0) out.push(el);
    }
    if (scope.classList?.contains("c-conversation-box-field")) break;
    scope = scope.parentElement;
  }
  return out;
}

/** Gom các tín hiệu Note mode tại thời điểm gọi (editor có thể bị Crisp thay node khi chuyển mode). */
function collectNoteSignals(editor) {
  const tab = findModeTab(editor, "Note");
  let yellowBg = false;
  let noteClass = false;
  for (let node = editor; node && !noteClass; node = node.parentElement) {
    if (/(^|[\s_-])note(?=$|[\s_-])/i.test(classOf(node))) noteClass = true;
    if (!yellowBg) yellowBg = isYellowishColor(getComputedStyle(node).backgroundColor);
    if (node.classList?.contains("c-conversation-box-field")) break;
  }
  const attrPh = editor.getAttribute("data-placeholder")
    ?? editor.closest("[data-placeholder]")?.getAttribute("data-placeholder")
    ?? editor.getAttribute("aria-label")
    ?? "";
  // Placeholder trên Crisp thật là CHỮ RENDER quanh editor ("Send a private
  // note to your team…" / "Send your message to … in chat…", phiên dò
  // 2026-10-26), không nằm ở thuộc tính — đọc cả hai đường, thuộc tính chỉ là
  // dự phòng. Nhãn "Note" trong vùng soạn (pill ở đầu dòng soạn) cũng là tín
  // hiệu riêng của Note mode; chỉ tìm trong wrapper sát editor để không nhầm
  // nhãn của tab Note trên thanh tab.
  let phKind = placeholderKind(attrPh) ?? (/note/i.test(attrPh) ? "note" : null);
  let notePill = false;
  const field = editor.parentElement;
  if (field) {
    for (const el of field.querySelectorAll("*")) {
      if (el === editor || editor.contains(el) || el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (!phKind) phKind = placeholderKind(t);
      if (t === "Note") notePill = true;
    }
  }
  if (!phKind) {
    for (const el of fieldLeaves(editor)) {
      const k = placeholderKind((el.textContent || "").trim());
      if (k) { phKind = k; break; }
    }
  }
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Điền private note vào ô Note: bấm tab Note → chờ + xác nhận Note mode bằng
 * confirmNoteMode → kiểm tra lại lần cuối ngay trước khi ghi. Bất kỳ bước nào
 * không chắc chắn đều trả "note_unconfirmed" và KHÔNG ghi ký tự nào.
 */
async function insertIntoNote(msg, reply) {
  let editor = findComposer();
  if (!editor) return reply("composer_not_found");
  let { tab, signals } = collectNoteSignals(editor);
  // BẢN CŨ bắt buộc tìm thấy tab Note rồi mới xét tín hiệu — mà tìm tab là
  // khâu dễ trượt nhất (class băm, tab nằm ngoài tầm leo DOM), nên Note mode
  // đã bật sẵn vẫn bị trả note_unconfirmed (Ethan test live 2026-10-26: tab
  // Note đang mở, placeholder "Send a private note…" hiện rõ mà vẫn lỗi).
  // Nay: tín hiệu phía editor là quyết định chính (đúng thiết kế cổng v2);
  // tab chỉ dùng để BẤM CHUYỂN mode khi tín hiệu chưa đạt.
  if (!confirmNoteMode(signals) && tab) {
    tab.click();
    // Chuyển mode là bất đồng bộ (Crisp thay node editor/nền): chờ tối đa ~1s.
    for (let i = 0; i < 12; i++) {
      await delay(80);
      editor = findComposer();
      if (!editor) continue;
      ({ tab, signals } = collectNoteSignals(editor));
      if (confirmNoteMode(signals)) break;
    }
  }
  editor = findComposer();
  if (!editor) return reply("composer_not_found");
  ({ signals } = collectNoteSignals(editor));
  if (!confirmNoteMode(signals)) return reply("note_unconfirmed");
  const d = decideInsert({ urlSession: sessionFromUrl(location.href), cmd: msg, composerText: readText(editor), insertedIds: inserted });
  if (d.status !== "inserted") return reply(d.status);
  // Điền và kiểm chứng TOÀN VĂN: lệch là báo insert_unverified, không báo
  // inserted giả (xem fillEditor).
  if (!fillEditor(editor, d.text)) return reply("insert_unverified");
  inserted.add(msg.output_id);
  reply("inserted");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "copilot:insert") return;
  const reply = (status) => sendResponse({ type: "copilot:insert_result", request_id: msg.request_id, status });
  if (msg.target === "note") {
    insertIntoNote(msg, reply).catch(() => reply("note_unconfirmed"));
    return true; // trả lời bất đồng bộ — giữ kênh sendResponse
  }
  const el = findComposer();
  if (!el) return reply("composer_not_found");
  const d = decideInsert({ urlSession: sessionFromUrl(location.href), cmd: msg, composerText: readText(el), insertedIds: inserted });
  if (d.status !== "inserted") return reply(d.status);
  if (!fillEditor(el, d.text)) return reply("insert_unverified");
  inserted.add(msg.output_id);
  reply("inserted");
});
