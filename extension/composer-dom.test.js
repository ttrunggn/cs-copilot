import { assertEquals } from "jsr:@std/assert@1";
import { bridgeState } from "../widget/bridge-core.js";

// Mô phỏng DOM tối thiểu cho extension/composer.js THẬT (không phải bản sao
// logic): nạp source composer-core.js + composer.js, gộp như scripts/
// build-extension.mjs (bỏ `export `), rồi chạy bằng new Function với
// document/chrome/location/getComputedStyle giả viết tay — không jsdom.
// Giới hạn của fake này (ghi rõ để không hiểu nhầm độ phủ):
// - Editor được mô hình hoá là <textarea name="message"> (nhánh writeText đơn
//   giản); nhánh Lexical contenteditable (paste/beforeinput) không chạy ở đây.
// - document.querySelectorAll chỉ khớp selector theo tag/class/contenteditable
//   một cách thô; thứ tự ưu tiên selector trên DOM Crisp thật vẫn cần live.
// - scope.querySelectorAll của element trả mọi hậu duệ; việc lọc nhãn tab do
//   chính code composer làm (đó mới là phần cần kiểm).

class FakeEl {
  constructor(tag, opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attrs = new Map(Object.entries(opts.attrs ?? {}));
    this.className = opts.className ?? "";
    this.text = opts.text ?? "";
    this.value = opts.value ?? "";
    this.innerText = opts.value ?? "";
    this.__bg = opts.bg ?? "rgb(255, 255, 255)";
    this.__cursor = opts.cursor ?? "auto";
    this.clickCount = 0;
    this.onClick = opts.onClick ?? null;
    this.ownerDoc = null;
    this.classList = { contains: (c) => this.className.split(/\s+/).includes(c) };
  }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  getAttribute(name) {
    if (name === "class") return this.className;
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, v) { if (name === "class") this.className = String(v); else this.attrs.set(name, String(v)); }
  append(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
  querySelectorAll() {
    const out = [];
    const rec = (n) => { for (const c of n.children) { out.push(c); rec(c); } };
    rec(this);
    return out;
  }
  contains(el) { let n = el; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
  closest(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    let n = this;
    while (n) {
      for (const p of parts) {
        if (p.startsWith("[role=")) { if (n.getAttribute("role") === p.match(/'([^']+)'/)?.[1]) return n; }
        else if (p.startsWith("[data-")) { if (n.getAttribute(p.slice(1, -1)) != null) return n; }
        else if (n.tagName === p.toUpperCase()) return n;
      }
      n = n.parentElement;
    }
    return null;
  }
  click() { this.clickCount++; this.onClick?.(this); }
  focus() { if (this.ownerDoc) this.ownerDoc.focused = this; }
  select() {}
  dispatchEvent() { return true; }
  getBoundingClientRect() { return { width: 120, height: 24 }; }
}

function matchesComposerSelector(elm, sel) {
  if (sel.includes("contenteditable")) return elm.getAttribute("contenteditable") === "true";
  if (sel.startsWith("textarea")) return elm.tagName === "TEXTAREA";
  if (sel.startsWith(".")) return elm.className.split(/\s+/).includes(sel.slice(1).split(/\s/)[0]);
  return false;
}

/**
 * Dựng một "trang Crisp" giả: thanh tab Reply|Note + editor.
 * switchable: bấm tab Note có thật sự chuyển mode không (Crisp khoẻ) hay
 * bấm mà không đổi gì (ca thiếu tín hiệu). notePreActive: đã ở Note mode sẵn.
 */
function buildPage({ switchable = true, notePreActive = false, withNoteTab = true } = {}) {
  const doc = { focused: null, current: null };
  const root = new FakeEl("div", { className: "c-conversation-box-field" });
  const toolbar = new FakeEl("div");
  const wrap = new FakeEl("div", notePreActive ? { bg: "rgb(255, 249, 196)" } : {});
  const mkTab = (label) => {
    const btn = new FakeEl("button", { className: "tab" });
    btn.append(new FakeEl("span", { text: label }));
    return btn;
  };
  const replyTab = mkTab("Reply");
  const noteTab = withNoteTab ? mkTab("Note") : null;
  toolbar.append(replyTab, ...(noteTab ? [noteTab] : []));
  const replyEditor = new FakeEl("textarea", { attrs: { name: "message", "data-placeholder": "Reply to customer…" } });
  const noteEditor = new FakeEl("textarea", { attrs: { name: "message", "data-placeholder": "Write a private note…" } });
  for (const e of [replyEditor, noteEditor]) e.ownerDoc = doc;
  doc.current = notePreActive ? noteEditor : replyEditor;
  wrap.append(doc.current);
  root.append(toolbar, wrap);
  const activateNote = () => {
    noteTab.className = "tab active";
    noteTab.setAttribute("aria-selected", "true");
    wrap.__bg = "rgb(255, 249, 196)"; // nền vàng Note mode
    doc.current = noteEditor; // Crisp thay node editor khi chuyển mode
    wrap.children = [noteEditor];
    noteEditor.parentElement = wrap;
  };
  if (noteTab) noteTab.onClick = switchable ? activateNote : () => {};
  if (notePreActive && noteTab) {
    noteTab.className = "tab active";
    noteTab.setAttribute("aria-selected", "true");
  } else {
    replyTab.className = "tab active";
    replyTab.setAttribute("aria-selected", "true");
  }
  const documentFake = {
    querySelectorAll: (sel) => (doc.current && matchesComposerSelector(doc.current, sel) ? [doc.current] : []),
    execCommand: (cmd, _ui, val) => {
      if (cmd === "insertText" && doc.focused) { doc.focused.value = val; doc.focused.innerText = val; }
      return true;
    },
  };
  return { doc, documentFake, root, replyTab, noteTab, replyEditor, noteEditor };
}

async function loadComposer(page) {
  const core = await Deno.readTextFile(new URL("./composer-core.js", import.meta.url));
  const src = await Deno.readTextFile(new URL("./composer.js", import.meta.url));
  const bundle = `${core.replace(/^export /gm, "")}\n\n${src}`;
  let listener = null;
  const chromeFake = { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } };
  const getComputedStyleFake = (elm) => ({ backgroundColor: elm.__bg ?? "rgb(255, 255, 255)", cursor: elm.__cursor ?? "auto" });
  const run = new Function("document", "chrome", "location", "getComputedStyle", "getSelection", bundle);
  run(page.documentFake, chromeFake, { href: "https://app.crisp.chat/website/ws1/inbox/session_1/" }, getComputedStyleFake, () => ({ removeAllRanges() {}, addRange() {} }));
  return (msg) => new Promise((resolve) => listener(msg, {}, resolve));
}

const NOTE_MSG = { type: "copilot:insert", request_id: "r-note", output_id: "note-1", session_id: "session_1", text: "NOTE NỘI BỘ", mode: "auto", target: "note" };

Deno.test("composer DOM (a): note — bấm tab Note, đủ tín hiệu (tab active + nền vàng/placeholder) → điền vào editor Note, ô Reply không đổi", async () => {
  const page = buildPage();
  const send = await loadComposer(page);
  const res = await send({ ...NOTE_MSG });
  assertEquals(res.type, "copilot:insert_result");
  assertEquals(res.request_id, "r-note");
  assertEquals(res.status, "inserted");
  // Kết quả kèm trace chẩn đoán (panel hiện khi lỗi; có cả khi thành công).
  assertEquals(Array.isArray(res.trace), true);
  assertEquals(page.noteTab.clickCount, 1); // phải tự bấm chuyển tab
  assertEquals(page.noteEditor.value, "NOTE NỘI BỘ");
  assertEquals(page.replyEditor.value, ""); // ô Reply không bị đụng vào
});

Deno.test("composer DOM (a2): đã ở Note mode sẵn (tab active + nền vàng) → điền ngay, không bấm tab lại", async () => {
  const page = buildPage({ notePreActive: true });
  const send = await loadComposer(page);
  const res = await send({ ...NOTE_MSG, output_id: "note-2" });
  assertEquals(res.status, "inserted");
  assertEquals(page.noteTab.clickCount, 0);
  assertEquals(page.noteEditor.value, "NOTE NỘI BỘ");
});

Deno.test("composer DOM (b): draft (không target) → điền thẳng ô Reply; gửi lại cùng output_id → duplicate; ô có chữ → not_empty; sai chat → session_mismatch", async () => {
  const page = buildPage();
  const send = await loadComposer(page);
  const draft = { type: "copilot:insert", request_id: "r1", output_id: 42, session_id: "session_1", text: "Draft trả khách", mode: "auto" };
  assertEquals((await send(draft)).status, "inserted");
  assertEquals(page.replyEditor.value, "Draft trả khách");
  assertEquals((await send({ ...draft, request_id: "r2" })).status, "duplicate");
  assertEquals(page.replyEditor.value, "Draft trả khách");
  assertEquals((await send({ ...draft, request_id: "r3", output_id: 43 })).status, "not_empty");
  assertEquals((await send({ ...draft, request_id: "r4", output_id: 44, session_id: "session_2" })).status, "session_mismatch");
  assertEquals(page.replyEditor.value, "Draft trả khách"); // sau mọi ca lỗi, nội dung không đổi
});

Deno.test("composer DOM (c): bấm tab Note mà Crisp không chuyển mode (thiếu tín hiệu editor) → note_unconfirmed và KHÔNG điền ký tự nào", async () => {
  const page = buildPage({ switchable: false });
  const send = await loadComposer(page);
  const res = await send({ ...NOTE_MSG, output_id: "note-3" });
  assertEquals(res.status, "note_unconfirmed");
  assertEquals(page.noteTab.clickCount, 1); // có bấm thử
  assertEquals(page.noteEditor.value, "");
  assertEquals(page.replyEditor.value, ""); // tuyệt đối không rơi vào ô Reply
});

Deno.test("composer DOM (c2): không có tab Note trong vùng ô soạn → note_unconfirmed ngay, không điền", async () => {
  const page = buildPage({ withNoteTab: false });
  const send = await loadComposer(page);
  const res = await send({ ...NOTE_MSG, output_id: "note-4" });
  assertEquals(res.status, "note_unconfirmed");
  assertEquals(page.replyEditor.value, "");
});

/**
 * Mô phỏng Crisp THẬT theo phiên dò 2026-10-26 (khác hẳn buildPage kiểu cũ):
 * class của tab là chuỗi băm (không token active, không aria-selected), editor
 * KHÔNG có data-placeholder; placeholder là CHỮ RENDER cạnh editor và Note
 * mode có thêm nhãn "Note" trong vùng soạn; nền Note trên giao diện tối là
 * olive sẫm rgb(58, 53, 32), nền Reply tối lạnh rgb(20, 24, 36).
 */
function buildRealPage({ switchable = true } = {}) {
  const doc = { focused: null, current: null };
  const root = new FakeEl("div", { className: "c-conversation-box-field" });
  const toolbar = new FakeEl("div");
  const wrap = new FakeEl("div", { bg: "rgb(20, 24, 36)" });
  const mkTab = (label) => {
    const div = new FakeEl("div", { className: "css-x1a2b3", cursor: "pointer" });
    div.append(new FakeEl("span", { text: label, cursor: "pointer" }));
    return div;
  };
  const replyTab = mkTab("Reply");
  const noteTab = mkTab("Note");
  toolbar.append(replyTab, noteTab);
  const replyEditor = new FakeEl("textarea", { attrs: { name: "message" } });
  const noteEditor = new FakeEl("textarea", { attrs: { name: "message" } });
  for (const e of [replyEditor, noteEditor]) e.ownerDoc = doc;
  const replyPh = new FakeEl("div", { text: "Send your message to trung nguyen in chat…" });
  const notePh = new FakeEl("div", { text: "Send a private note to your team…" });
  const notePill = new FakeEl("span", { text: "Note" });
  doc.current = replyEditor;
  wrap.append(replyEditor, replyPh);
  root.append(toolbar, wrap);
  // Click trên Crisp thật dội từ nhãn chữ lên tab (React hứng ở gốc) — fake
  // không có bubbling nên gắn handler cho cả nhãn span, và handler tự đếm vào
  // noteTab.clickCount để test khẳng định được đã bấm.
  const activate = () => {
    noteTab.clickCount++;
    wrap.__bg = "rgb(58, 53, 32)"; // olive sẫm của Note mode (giao diện tối)
    doc.current = noteEditor; // Crisp thay node editor, class tab KHÔNG đổi
    wrap.children = [noteEditor, notePh, notePill];
    noteEditor.parentElement = wrap;
    notePh.parentElement = wrap;
    notePill.parentElement = wrap;
  };
  noteTab.onClick = switchable ? activate : () => {};
  noteTab.children[0].onClick = switchable ? activate : () => {};
  const documentFake = {
    querySelectorAll: (sel) => (doc.current && matchesComposerSelector(doc.current, sel) ? [doc.current] : []),
    execCommand: (cmd, _ui, val) => {
      if (cmd === "insertText" && doc.focused) { doc.focused.value = val; doc.focused.innerText = val; }
      return true;
    },
  };
  return { doc, documentFake, root, replyTab, noteTab, replyEditor, noteEditor };
}

Deno.test("composer DOM (e): Crisp thật (class băm, placeholder render, nền olive sẫm) → điền Note chạy nhờ tín hiệu phía editor", async () => {
  const page = buildRealPage();
  const send = await loadComposer(page);
  const res = await send({ ...NOTE_MSG, output_id: "note-5" });
  assertEquals(res.status, "inserted");
  assertEquals(page.noteTab.clickCount, 1);
  assertEquals(page.noteEditor.value, "NOTE NỘI BỘ");
  assertEquals(page.replyEditor.value, "");
});

Deno.test("composer DOM (e2): Crisp thật nhưng bấm tab mà mode không chuyển → note_unconfirmed, không điền ký tự nào", async () => {
  const page = buildRealPage({ switchable: false });
  const send = await loadComposer(page);
  const res = await send({ ...NOTE_MSG, output_id: "note-6" });
  assertEquals(res.status, "note_unconfirmed");
  assertEquals(page.noteEditor.value, "");
  assertEquals(page.replyEditor.value, "");
});

Deno.test("composer DOM (f): ô Reply chỉ chứa ký tự zero-width → vẫn coi là trống, draft điền được", async () => {
  const page = buildPage();
  page.replyEditor.value = "\u200B";
  page.replyEditor.innerText = "\u200B";
  const send = await loadComposer(page);
  const draft = { type: "copilot:insert", request_id: "r-zw", output_id: 77, session_id: "session_1", text: "Draft sau zero-width", mode: "auto" };
  assertEquals((await send(draft)).status, "inserted");
  assertEquals(page.replyEditor.value, "Draft sau zero-width");
});

Deno.test("composer DOM (d): khoá lệch protocol nằm phía widget — pong protocol 1 → outdated (extension tự nó không kiểm protocol lệnh insert)", () => {
  // bridgeState là cổng duy nhất: widget thấy protocol ≠ 2 thì outdated và
  // panels không render nút điền (xem widget/panels.test.js). Phía extension,
  // bridge.js/composer.js/background.js không hề đọc msg.protocol — ca này
  // khoá lại sự thật kiến trúc đó để lần sửa sau không tưởng nhầm là đã khoá 2 phía.
  assertEquals(bridgeState({ type: "copilot:pong", protocol: 1, version: "1.0.0" }), "outdated");
  assertEquals(bridgeState({ type: "copilot:pong", protocol: 2, version: "1.1.0" }), "ready");
});

/**
 * Mô phỏng cấu trúc composer mà phiên dò 2026-10-26 gợi ý trên Crisp thật:
 * phần "trang trí" Note mode nằm ở CONTAINER phía trên .c-conversation-box-field
 * (nền vàng phủ cả hàng tab; pill + placeholder là con của container, anh em
 * của box-field). Bản cũ gom tín hiệu chỉ trong box-field → không bao giờ đủ
 * tín hiệu → note_unconfirmed dù tab đã chuyển (ca live 2026-10-26 16:35:
 * tab tự sang Note, ô trống nguyên).
 */
function buildWidePage() {
  const doc = { focused: null, current: null };
  const container = new FakeEl("div", { bg: "rgb(20, 24, 36)" });
  const toolbar = new FakeEl("div");
  const field = new FakeEl("div", { className: "c-conversation-box-field" });
  const wrap = new FakeEl("div");
  const mkTab = (label) => {
    const div = new FakeEl("div", { className: "css-h4sh", cursor: "pointer" });
    div.append(new FakeEl("span", { text: label, cursor: "pointer" }));
    return div;
  };
  const replyTab = mkTab("Reply");
  const noteTab = mkTab("Note");
  toolbar.append(replyTab, noteTab);
  const replyEditor = new FakeEl("textarea", { attrs: { name: "message" } });
  const noteEditor = new FakeEl("textarea", { attrs: { name: "message" } });
  for (const e of [replyEditor, noteEditor]) e.ownerDoc = doc;
  const replyPh = new FakeEl("div", { text: "Send your message to trung nguyen in chat…" });
  const notePh = new FakeEl("div", { text: "Send a private note to your team…" });
  const notePill = new FakeEl("span", { text: "Note" });
  doc.current = replyEditor;
  wrap.append(replyEditor);
  field.append(wrap);
  container.append(toolbar, field, replyPh);
  const activate = () => {
    noteTab.clickCount++;
    container.__bg = "rgb(58, 53, 32)"; // nền vàng phủ cả container (gồm hàng tab)
    doc.current = noteEditor;
    wrap.children = [noteEditor];
    noteEditor.parentElement = wrap;
    container.children = [toolbar, field, notePh, notePill];
    notePh.parentElement = container;
    notePill.parentElement = container;
  };
  noteTab.onClick = activate;
  noteTab.children[0].onClick = activate;
  const documentFake = {
    querySelectorAll: (sel) => (doc.current && matchesComposerSelector(doc.current, sel) ? [doc.current] : []),
    execCommand: (cmd, _ui, val) => {
      if (cmd === "insertText" && doc.focused) { doc.focused.value = val; doc.focused.innerText = val; }
      return true;
    },
  };
  return { doc, documentFake, root: container, replyTab, noteTab, replyEditor, noteEditor };
}

Deno.test("composer DOM (g): trang trí Note mode nằm TRÊN box-field (container) → vẫn đủ tín hiệu và điền được (hồi quy ca live 16:35)", async () => {
  const page = buildWidePage();
  const send = await loadComposer(page);
  const res = await send({ ...NOTE_MSG, output_id: "note-7" });
  assertEquals(res.status, "inserted");
  assertEquals(page.noteEditor.value, "NOTE NỘI BỘ");
  assertEquals(page.replyEditor.value, "");
  // Trace phải ghi nhận tín hiệu đã thấy ở phạm vi rộng (yel/ph/pil).
  assertEquals(res.trace.some((t) => t.includes("yel1") && t.includes("ph1")), true);
});
