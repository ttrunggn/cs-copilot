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
