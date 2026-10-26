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
  const squash = (s) => normalizeComposerText(s).replace(/\s+/g, " ").trim();
  const a = squash(readBack);
  const b = squash(expected);
  return b.length > 0 && a === b;
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


// Chạy ở top frame app.crisp.chat: tìm ô soạn và chèn nội dung như người gõ để editor của Crisp nhận.
// Hai đích: ô Reply (draft/review, mặc định) và ô Note (private note — msg.target === "note").
// Note là nội dung nội bộ: chỉ điền khi ĐÃ XÁC NHẬN đang ở Note mode (xem
// confirmNoteMode ở composer-core), không xác nhận được thì huỷ, không điền gì cả.
// Mọi lần điền đều để lại "trace" — vết chẩn đoán gọn trả kèm kết quả để panel
// hiện trong thông báo lỗi: lần test live nào lỗi là thấy ngay khâu nào
// (tín hiệu Note, xoá, ghi, khớp) thay vì đoán (Ethan test live 2026-10-26:
// điền Note + gấp đôi nội dung ở bản 1.2.1 mà không có dữ kiện nào để truy).
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
 * Xoá SẠCH ô soạn và kiểm chứng rỗng thật. Bản cũ chỉ bắn MỘT beforeinput
 * deleteContentBackward tổng hợp — Lexical nuốt sự kiện đó mà không xoá, nên
 * bước paste sau đó dán bản mới LÊN TRÊN bản cũ: "thay thế" thành chèn thêm,
 * nội dung lặp 2-3 lần (Ethan test live 2026-10-26). Nay thử lần lượt:
 * execCommand("delete") trên vùng chọn toàn bộ → phím Backspace → beforeinput
 * → xoá node qua Selection API; cách nào làm ô rỗng thật mới tính là xong.
 * Bước xoá DOM thẳng phải CHỜ rồi đọc lại: Lexical có thể dựng lại nội dung
 * cũ từ state của nó ngay sau khi DOM bị đụng vào — đọc ngay thấy rỗng giả,
 * dán tiếp là gấp đôi (đúng ca gấp đôi ở ô Reply trên bản 1.2.1).
 */
async function clearEditor(el, trace) {
  if (!readText(el).trim()) { trace?.push("clr:empty"); return true; }
  const gone = () => !readText(el).trim();
  // Mỗi cách xoá phải được xác nhận SAU một nhịp chờ mới tin: editor có thể
  // "dựng lại" nội dung cũ từ state riêng của nó ngay sau khi DOM bị xoá
  // thẳng — đọc ngay lập tức thấy rỗng giả, tưởng đã sạch mà dán tiếp là
  // gấp đôi (đúng ca gấp đôi ở ô Reply trên bản live 2026-10-26).
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

/**
 * Phạm vi gom tín hiệu Note mode: leo từ editor lên (tối đa 8 tầng) tới
 * container chứa CẢ thanh tab (có lá "Reply" và lá "Note"). Bản cũ dừng ở
 * .c-conversation-box-field — nhưng trên Crisp thật, phần "trang trí" của
 * Note mode (nền vàng phủ cả hàng tab, pill "Note", placeholder) nằm ở
 * container composer PHÍA TRÊN box-field (phiên dò 2026-10-26: nền vàng phủ
 * cả hàng tab lẫn hàng soạn), nên tín hiệu không bao giờ lọt vào phạm vi cũ
 * và cổng xác nhận không qua nổi dù CS đã mở sẵn tab Note (ca live
 * 2026-10-26: tab tự chuyển sang Note mà ô vẫn trống).
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
  let yellowBg = false;
  let noteClass = false;
  for (let node = editor; node; node = node.parentElement) {
    if (/(^|[\s_-])note(?=$|[\s_-])/i.test(classOf(node))) noteClass = true;
    if (!yellowBg) yellowBg = isYellowishColor(getComputedStyle(node).backgroundColor);
    if (node === root) break;
  }
  const attrPh = editor.getAttribute("data-placeholder")
    ?? editor.closest("[data-placeholder]")?.getAttribute("data-placeholder")
    ?? editor.getAttribute("aria-label")
    ?? "";
  // Placeholder trên Crisp thật là CHỮ RENDER quanh editor ("Send a private
  // note to your team…" / "Send your message to … in chat…", phiên dò
  // 2026-10-26), không nằm ở thuộc tính — đọc cả hai đường, thuộc tính chỉ là
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
    if (el === editor || editor.contains(el) || el.children.length) continue;
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
 * Điền private note vào ô Note: bấm tab Note → chờ + xác nhận Note mode bằng
 * confirmNoteMode → kiểm tra lại lần cuối ngay trước khi ghi. Bất kỳ bước nào
 * không chắc chắn đều trả "note_unconfirmed" và KHÔNG ghi ký tự nào.
 */
async function insertIntoNote(msg, reply) {
  const trace = [];
  let editor = findComposer();
  if (!editor) return reply("composer_not_found", trace);
  let { tab, signals } = collectNoteSignals(editor);
  trace.push(`sig0 ${signalTrace(signals)}`);
  // BẢN CŨ bắt buộc tìm thấy tab Note rồi mới xét tín hiệu — mà tìm tab là
  // khâu dễ trượt nhất (class băm, tab nằm ngoài tầm leo DOM), nên Note mode
  // đã bật sẵn vẫn bị trả note_unconfirmed (Ethan test live 2026-10-26: tab
  // Note đang mở, placeholder "Send a private note…" hiện rõ mà vẫn lỗi).
  // Nay: tín hiệu phía editor là quyết định chính (đúng thiết kế cổng v2);
  // tab chỉ dùng để BẤM CHUYỂN mode khi tín hiệu chưa đạt.
  if (!confirmNoteMode(signals) && tab) {
    tab.click();
    trace.push("click");
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
  if (!editor) return reply("composer_not_found", trace);
  ({ signals } = collectNoteSignals(editor));
  trace.push(`sig1 ${signalTrace(signals)}`);
  if (!confirmNoteMode(signals)) return reply("note_unconfirmed", trace);
  const d = decideInsert({ urlSession: sessionFromUrl(location.href), cmd: msg, composerText: readText(editor), insertedIds: inserted });
  if (d.status !== "inserted") return reply(d.status, trace);
  // Điền và kiểm chứng TOÀN VĂN: lệch là báo insert_unverified, không báo
  // inserted giả (xem fillEditor).
  if (!(await fillEditor(editor, d.text, trace, findComposer))) return reply("insert_unverified", trace);
  inserted.add(msg.output_id);
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
    const d = decideInsert({ urlSession: sessionFromUrl(location.href), cmd: msg, composerText: readText(el), insertedIds: inserted });
    if (d.status !== "inserted") return reply(d.status, trace);
    if (!(await fillEditor(el, d.text, trace, findComposer))) return reply("insert_unverified", trace);
    inserted.add(msg.output_id);
    reply("inserted", trace);
  })().catch(() => reply("insert_unverified"));
  return true;
});
