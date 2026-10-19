// Chạy ở top frame app.crisp.chat: tìm ô Reply và chèn draft như người gõ để editor của Crisp nhận.
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "copilot:insert") return;
  const reply = (status) => sendResponse({ type: "copilot:insert_result", request_id: msg.request_id, status });
  const el = findComposer();
  if (!el) return reply("composer_not_found");
  const d = decideInsert({ urlSession: sessionFromUrl(location.href), cmd: msg, composerText: readText(el), insertedIds: inserted });
  if (d.status !== "inserted") return reply(d.status);
  writeText(el, d.text);
  inserted.add(msg.output_id);
  reply("inserted");
});
