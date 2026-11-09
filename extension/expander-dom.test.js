import { assertEquals } from "jsr:@std/assert@1";

// Mô phỏng DOM tối thiểu cho phần TỰ MỞ RỘNG trong extension/composer.js
// THẬT: nạp bundle composer-core + composer như build-extension.mjs, chạy
// bằng new Function với document/MutationObserver/setInterval giả — test
// điều khiển từng nhịp tick tay để khẳng định đúng chuỗi bấm/không bấm.
// Cây DOM theo cấu trúc của Crisp: hộp
// widget = iframe + div body chứa span.c-conversation-profile-widget__
// expand (trong có svg icon). "Đã mở rộng" được giả lập bằng cách gỡ span
// khỏi cây — tương đương tín hiệu thật (span còn trong DOM nhưng bị
// iframe phủ, isExpandActionable trả false); FakeEl không có API đo hình
// học nên isExpandActionable ở đây luôn true khi span còn hiện diện.

class FakeEl {
  constructor(tag, opts = {}, kids = []) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map(Object.entries(opts.attrs ?? {}));
    this.text = opts.text ?? "";
    this.children = [];
    this.parentElement = null;
    this.clickCount = 0;
    this.onClick = opts.onClick ?? null;
    for (const k of kids) this.append(k);
  }
  append(k) { k.parentElement = this; this.children.push(k); return this; }
  remove(k) { this.children = this.children.filter((c) => c !== k); k.parentElement = null; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  querySelectorAll(sel) {
    const want = String(sel).toUpperCase();
    const out = [];
    const rec = (n) => { for (const c of n.children) { if (c.tagName === want) out.push(c); rec(c); } };
    rec(this);
    return out;
  }
  click() { this.clickCount++; this.onClick?.(this); }
  dispatchEvent(evt) { if (evt?.type === "click") this.click(); return true; }
}

/** Trang Crisp giả theo DOM của Crisp: hộp Copilot = iframe + div body chứa span Expand > svg icon. */
function buildPage(session = "session_1") {
  const frame = new FakeEl("iframe", { attrs: { src: `__WIDGET_ORIGIN__/index.html?session_id=${session}&website_id=ws1` } });
  const expandIcon = new FakeEl("svg", { attrs: { class: "c-base-icon c-conversation-profile-widget__expand-icon" } });
  const expandSpan = new FakeEl("span", { attrs: { class: "c-conversation-profile-widget__expand u-has-tooltip" } }, [expandIcon]);
  const body = new FakeEl("div", {}, [expandSpan]);
  const box = new FakeEl("div", {}, [frame, body]);
  const root = new FakeEl("div", {}, [box]);
  const page = {
    frame, expandSpan, expandIcon, body, root,
    collapse() { if (!body.children.includes(expandSpan)) body.append(expandSpan); },
    expandApplied() { if (body.children.includes(expandSpan)) body.remove(expandSpan); },
    switchSession(next) {
      frame.setAttribute("src", `__WIDGET_ORIGIN__/index.html?session_id=${next}&website_id=ws1`);
      page.collapse();
    },
  };
  return page;
}

async function loadExpander(page) {
  const core = await Deno.readTextFile(new URL("./composer-core.js", import.meta.url));
  const src = await Deno.readTextFile(new URL("./composer.js", import.meta.url));
  const bundle = `${core.replace(/^export /gm, "")}\n\n${src}`;
  const captured = { tick: null, observed: null };
  class FakeMutationObserver {
    constructor(cb) { captured.observed = cb; }
    observe() {}
  }
  const documentFake = {
    documentElement: page.root,
    querySelectorAll: (sel) => (sel === "iframe" ? [page.frame] : []),
  };
  const chromeFake = { runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "test" }), id: "test" } };
  const run = new Function("document", "chrome", "location", "getComputedStyle", "getSelection", "MutationObserver", "setInterval", bundle);
  run(documentFake, chromeFake, { href: "https://app.crisp.chat/website/ws1/inbox/session_1/" },
    () => ({ display: "block", visibility: "visible", backgroundColor: "rgb(0,0,0)", cursor: "auto" }),
    () => ({ removeAllRanges() {}, addRange() {} }),
    FakeMutationObserver,
    (fn) => { captured.tick = fn; return 1; });
  return captured;
}

Deno.test("expander DOM: tự bấm Expand khi nạp; người đóng tay thì không mở lại; sang chat mới thì mở lại", async () => {
  const page = buildPage("session_1");
  const { tick } = await loadExpander(page);
  assertEquals(page.expandIcon.clickCount, 1); // autoExpandTick chạy ngay khi nạp

  page.expandApplied(); // Crisp mở lớp phủ → nút không còn bấm được
  tick(); tick();
  assertEquals(page.expandIcon.clickCount, 1);

  page.collapse(); // người dùng bấm Close → hộp thu gọn trở lại
  tick(); tick();
  assertEquals(page.expandIcon.clickCount, 1); // không giành lại

  page.switchSession("session_2"); // chat mới, hộp thu gọn
  tick();
  assertEquals(page.expandIcon.clickCount, 2); // mở cho chat mới
});

Deno.test("expander DOM: iframe của plugin khác → không bấm gì", async () => {
  const page = buildPage("session_1");
  page.frame.setAttribute("src", "https://plugin-khac.example/widget?session_id=session_1");
  const { tick } = await loadExpander(page);
  tick(); tick();
  assertEquals(page.expandIcon.clickCount, 0);
});
