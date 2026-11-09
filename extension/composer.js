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
const WIDGET_ORIGIN = "__WIDGET_ORIGIN__";
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
