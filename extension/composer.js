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
  return r.width > 0 && r.height > 0;
}

function findComposer() {
  for (const sel of COMPOSER_SELECTORS) {
    const el = [...document.querySelectorAll(sel)].find(visible);
    if (el) return el;
  }
  return null;
}

function readText(el) {
  return el.tagName === "TEXTAREA" ? el.value : el.innerText;
}

function selectAll(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Lexical bỏ xuống dòng khi dùng insertText, nhưng nhận paste thành từng đoạn. Xoá bằng beforeinput như phím Backspace.
function writeText(el, text) {
  if (el.tagName === "TEXTAREA") {
    el.focus();
    el.select();
    document.execCommand("insertText", false, text);
    return;
  }
  selectAll(el);
  if (el.innerText.trim()) {
    el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
    selectAll(el);
  }
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const handled = !el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  if (!handled) document.execCommand("insertText", false, text);
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
  for (let i = 0; i < 7 && scope; i++) {
    const tab = findTabIn(scope, editor, label);
    if (tab) return tab;
    scope = scope.parentElement;
  }
  return null;
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
  const ph = editor.getAttribute("data-placeholder")
    ?? editor.closest("[data-placeholder]")?.getAttribute("data-placeholder")
    ?? editor.getAttribute("aria-label")
    ?? "";
  return {
    tab,
    signals: {
      tabActive: tab ? tabLooksActive({ className: classOf(tab), ariaSelected: tab.getAttribute("aria-selected") ?? tab.getAttribute("aria-pressed"), dataState: tab.getAttribute("data-state") ?? "" }) : false,
      yellowBg,
      noteClass,
      notePlaceholder: /note/i.test(ph),
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
  if (!tab) return reply("note_unconfirmed");
  if (!confirmNoteMode(signals)) {
    tab.click();
    // Chuyển mode là bất đồng bộ (Crisp thay node editor/nền): chờ tối đa ~1s.
    for (let i = 0; i < 12; i++) {
      await delay(80);
      editor = findComposer();
      if (!editor) continue;
      ({ tab, signals } = collectNoteSignals(editor));
      if (tab && confirmNoteMode(signals)) break;
    }
  }
  editor = findComposer();
  if (!editor) return reply("composer_not_found");
  ({ signals } = collectNoteSignals(editor));
  if (!confirmNoteMode(signals)) return reply("note_unconfirmed");
  const d = decideInsert({ urlSession: sessionFromUrl(location.href), cmd: msg, composerText: readText(editor), insertedIds: inserted });
  if (d.status !== "inserted") return reply(d.status);
  writeText(editor, d.text);
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
  writeText(el, d.text);
  inserted.add(msg.output_id);
  reply("inserted");
});
