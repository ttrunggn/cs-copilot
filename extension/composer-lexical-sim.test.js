// Test mô phỏng editor kiểu Lexical cho đường contenteditable của composer.
// Mô hình (không phải bản sao Crisp — dùng để khoá cơ chế điền):
// - state riêng (đoạn văn); innerText nối đoạn bằng "\n" đơn.
// - paste chỉ được xử lý khi rơi đúng vào contenteditable (listener trên editor).
// - Xoá ở tầng DOM (execCommand delete / range.deleteContents) KHÔNG đụng vào
//   state: DOM trống giả trong ~30ms rồi editor tự render lại từ state.
// - Chỉ pipeline sự kiện của chính editor (beforeinput/keydown với vùng chọn
//   nằm trong editor) mới xoá được state.
// Ba triệu chứng mô hình này dựng lại được nếu đường điền sai: điền Note thì
// tab chuyển mà ô trống; điền Reply qua wrapper thì không gì vào; điền Reply
// trực tiếp thì nội dung GẤP ĐÔI sau một lần bấm. Test khoá hành vi hiện tại:
// inserted + đúng một bản trong mọi biến thể.

class Ev {
  constructor(type, opts = {}) {
    this.type = type;
    this.key = opts.key;
    this.inputType = opts.inputType;
    this.clipboardData = opts.clipboardData;
    this.bubbles = true;
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
}
class DataTransferFake {
  constructor() { this.data = {}; }
  setData(k, v) { this.data[k] = v; }
  getData(k) { return this.data[k] ?? ""; }
}

class El {
  constructor(tag, opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attrs = new Map(Object.entries(opts.attrs ?? {}));
    this.className = opts.className ?? "";
    this.text = opts.text ?? "";
    this.__bg = opts.bg;
    this.__cursor = opts.cursor ?? "auto";
    this.listeners = {};
    this.clickCount = 0;
    this.onClick = opts.onClick ?? null;
    this.classList = { contains: (c) => this.className.split(/\s+/).includes(c) };
  }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  get innerText() { return this.textContent; }
  getAttribute(n) { return n === "class" ? this.className : (this.attrs.has(n) ? this.attrs.get(n) : null); }
  setAttribute(n, v) { if (n === "class") this.className = String(v); else this.attrs.set(n, String(v)); }
  append(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
  descendants() { const out = []; const rec = (n) => { for (const c of n.children) { out.push(c); rec(c); } }; rec(this); return out; }
  querySelectorAll(sel) {
    const all = this.descendants();
    if (sel === "*") return all;
    if (sel === "[contenteditable]") return all.filter((e) => e.getAttribute("contenteditable") != null);
    if (sel.includes("[data-mode]")) return all.filter((e) => e.getAttribute("data-mode") != null || e.getAttribute("data-tab") != null || e.getAttribute("aria-label") != null);
    if (sel.includes("button")) return all.filter((e) => ["BUTTON", "A", "DIV", "SPAN"].includes(e.tagName) || ["tab", "button"].includes(e.getAttribute("role")));
    return [];
  }
  contains(el) { let n = el; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
  closest(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    let n = this;
    while (n) {
      for (const p of parts) {
        if (p.startsWith("[data-")) { if (n.getAttribute(p.slice(1, -1)) != null) return n; }
        else if (p.startsWith("[role=")) { if (n.getAttribute("role") === p.match(/'([^']+)'/)?.[1]) return n; }
        else if (n.tagName === p.toUpperCase()) return n;
      }
      n = n.parentElement;
    }
    return null;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatchEvent(ev) {
    let ok = true;
    for (const fn of this.listeners[ev.type] ?? []) { fn(ev); if (ev.defaultPrevented) ok = false; }
    return ok;
  }
  click() { this.clickCount++; this.onClick?.(this); }
  focus() { if (this.ownerDoc) this.ownerDoc.focused = this; }
  select() {}
  getBoundingClientRect() { return { width: 200, height: 30 }; }
}

function makeEditor(doc) {
  const ed = new El("div", { className: "lx-root", attrs: { contenteditable: "true", role: "textbox" } });
  ed.state = [];
  ed.domOverride = undefined;
  Object.defineProperty(ed, "innerText", { get() { return ed.domOverride !== undefined ? ed.domOverride : ed.state.join("\n"); } });
  Object.defineProperty(ed, "textContent", { get() { return ed.innerText; } });
  ed.ownerDoc = doc;
  ed.addEventListener("paste", (ev) => {
    const t = ev.clipboardData?.getData("text/plain") ?? "";
    ed.state = [...ed.state, ...t.split(/\n\n+/)]; // đoạn văn tách bằng dòng trống; innerText nối đoạn bằng \n đơn
    ed.domOverride = undefined;
    ev.preventDefault();
  });
  const clearViaPipeline = (ev) => {
    if (doc.selection.root === ed) { ed.state = []; ed.domOverride = undefined; ev.preventDefault?.(); }
  };
  ed.addEventListener("beforeinput", (ev) => { if (ev.inputType === "deleteContentBackward") clearViaPipeline(ev); });
  ed.addEventListener("keydown", (ev) => { if (ev.key === "Backspace") clearViaPipeline(ev); });
  return ed;
}

function scheduleResurrect(ed) {
  setTimeout(() => { if (ed.domOverride === "") ed.domOverride = undefined; }, 10);
}

/**
 * Trang: container > toolbar(tabs) + field(.c-conversation-box-field) > wrap
 * > editorWrap(.c-conversation-box-field__field-composer-field) > editor.
 * Note dressing (nền vàng, placeholder, pill) nằm ở CONTAINER.
 * directEditor: editor mang luôn class composer-field (không qua wrapper).
 */
function buildPage({ directEditor = false } = {}) {
  const doc = { focused: null, selection: null };
  const container = new El("div", { bg: "rgb(20, 24, 36)" });
  const toolbar = new El("div");
  const field = new El("div", { className: "c-conversation-box-field" });
  const wrap = new El("div");
  const editor = makeEditor(doc);
  const editorWrap = directEditor ? editor : new El("div", { className: "c-conversation-box-field__field-composer-field" });
  if (directEditor) editor.className = "c-conversation-box-field__field-composer-field lx-root";
  const mkTab = (label) => {
    const d = new El("div", { className: "css-h4sh", cursor: "pointer" });
    d.append(new El("span", { text: label, cursor: "pointer" }));
    return d;
  };
  const replyTab = mkTab("Reply");
  const noteTab = mkTab("Note");
  toolbar.append(replyTab, noteTab);
  if (!directEditor) editorWrap.append(editor);
  wrap.append(editorWrap);
  field.append(wrap);
  const replyPh = new El("div", { text: "Send your message to trung nguyen in chat…" });
  const notePh = new El("div", { text: "Send a private note to your team…" });
  const notePill = new El("span", { text: "Note" });
  container.append(toolbar, field, replyPh);
  const activateNote = () => {
    container.__bg = "rgb(58, 53, 32)";
    container.children = [toolbar, field, notePh, notePill];
    notePh.parentElement = container;
    notePill.parentElement = container;
  };
  noteTab.onClick = activateNote;
  noteTab.children[0].onClick = activateNote;

  const selection = {
    root: null, rangeCount: 0, _range: null,
    removeAllRanges() { this.root = null; this.rangeCount = 0; this._range = null; },
    addRange(r) { this._range = r; this.root = r.root; this.rangeCount = 1; },
    getRangeAt() { return this._range; },
  };
  doc.selection = selection;
  const documentFake = {
    querySelectorAll(sel) {
      const all = container.descendants();
      if (sel === ".c-conversation-box-field__field-composer-field") return all.filter((e) => e.classList.contains("c-conversation-box-field__field-composer-field"));
      if (sel === ".c-conversation-box-field [contenteditable='true']") return all.filter((e) => e.getAttribute("contenteditable") === "true");
      if (sel === "[data-placeholder] [contenteditable='true']") return [];
      if (sel === "textarea[name='message']") return [];
      if (sel === "div[contenteditable='true'][role='textbox']") return all.filter((e) => e.tagName === "DIV" && e.getAttribute("contenteditable") === "true" && e.getAttribute("role") === "textbox");
      return [];
    },
    createRange() {
      return {
        root: null,
        selectNodeContents(el) { this.root = el; },
        deleteContents() { editor.domOverride = ""; scheduleResurrect(editor); },
      };
    },
    execCommand(cmd, _ui, val) {
      if (cmd === "insertText") {
        if (selection.root === editor) { editor.state = [...editor.state, ...String(val).split(/\n\n+/)]; editor.domOverride = undefined; }
        return true;
      }
      if (cmd === "delete") { editor.domOverride = ""; scheduleResurrect(editor); return true; }
      return true;
    },
  };
  const getComputedStyle = (el) => ({ backgroundColor: el.__bg ?? "rgb(255, 255, 255)", display: "block", visibility: "visible", cursor: el.__cursor ?? "auto" });
  return { doc, documentFake, getComputedStyle, selection, editor, noteTab, container };
}

async function loadBundle(page) {
  const core = await Deno.readTextFile(new URL("./composer-core.js", import.meta.url));
  const src = await Deno.readTextFile(new URL("./composer.js", import.meta.url));
  const bundle = `${core.replace(/^export /gm, "")}\n\n${src}`;
  let listener = null;
  const chromeFake = { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } };
  const run = new Function(
    "document", "chrome", "location", "getComputedStyle", "getSelection",
    "InputEvent", "KeyboardEvent", "ClipboardEvent", "DataTransfer",
    bundle,
  );
  run(
    page.documentFake, chromeFake,
    { href: "https://app.crisp.chat/website/ws1/inbox/session_1/" },
    page.getComputedStyle, () => page.selection,
    class extends Ev { constructor(type, opts) { super(type ?? "input", opts); } },
    class extends Ev { constructor(type, opts) { super(type ?? "keydown", opts); } },
    class extends Ev { constructor(type, opts) { super(type ?? "paste", opts); } },
    DataTransferFake,
  );
  return (msg) => new Promise((resolve) => listener(msg, {}, resolve));
}


const NOTE_TEXT = "Handoff — Test Agent\nKhách muốn gặp người thật.\n1. Yêu cầu gặp nhân viên — Đang xử lý: bot đã chuyển.\nTiếp theo (chờ CS): tiếp nhận hội thoại.";
const DRAFT_TEXT = "Hi there,\n\nThank you for reaching out to us.\n\nBelow is the direct link:\nhttps://apps.shopify.com/transcy\n\nThank you so much!";
const canon = (t) => t.split(/\n\n+/).join("\n");

function assertEquals(a, b, msg = "") {
  if (a !== b) throw new Error(`sai: ${JSON.stringify(a)} !== ${JSON.stringify(b)} ${msg}`);
}

Deno.test("lexical-sim: điền Note với trang trí Note mode nằm ở container phía trên box-field → inserted, đúng một bản", async () => {
  const page = buildPage();
  const send = await loadBundle(page);
  const res = await send({ type: "copilot:insert", request_id: "s1", output_id: "n1", session_id: "session_1", text: NOTE_TEXT, mode: "auto", target: "note" });
  assertEquals(res.status, "inserted");
  assertEquals(page.editor.state.join("\n"), NOTE_TEXT);
});

Deno.test("lexical-sim: điền Reply khi editor nằm trong wrapper → inserted đúng một bản; điền lại (replace) vẫn một bản nhờ xoá có xác nhận sau chờ", async () => {
  const page = buildPage();
  const send = await loadBundle(page);
  const res = await send({ type: "copilot:insert", request_id: "s2", output_id: "d1", session_id: "session_1", text: DRAFT_TEXT, mode: "replace", target: "reply" });
  assertEquals(res.status, "inserted");
  assertEquals(page.editor.state.join("\n"), canon(DRAFT_TEXT));
  const res2 = await send({ type: "copilot:insert", request_id: "s2b", output_id: "d2", session_id: "session_1", text: DRAFT_TEXT, mode: "replace", target: "reply" });
  assertEquals(res2.status, "inserted");
  assertEquals(page.editor.state.join("\n"), canon(DRAFT_TEXT));
  // Vết phải cho thấy lần xoá thứ hai không tin lần xoá DOM giả (clr:key =
  // xoá thật qua pipeline phím, sau khi nhịp chờ bắt được nội dung dựng lại).
  assertEquals((res2.trace ?? []).some((t) => t.startsWith("clr:key")), true);
});

Deno.test("lexical-sim: điền Reply khi editor mang luôn class composer-field (điều kiện ca gấp đôi) → inserted, không gấp đôi", async () => {
  const page = buildPage({ directEditor: true });
  const send = await loadBundle(page);
  const res = await send({ type: "copilot:insert", request_id: "s3", output_id: "d9", session_id: "session_1", text: DRAFT_TEXT, mode: "replace", target: "reply" });
  assertEquals(res.status, "inserted");
  assertEquals(page.editor.state.join("\n"), canon(DRAFT_TEXT));
});
