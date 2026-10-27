import { assertEquals } from "jsr:@std/assert@1";

// Mô phỏng DOM tối thiểu cho phần TỰ MỞ RỘNG trong extension/composer.js
// THẬT: nạp bundle composer-core + composer như build-extension.mjs, chạy
// bằng new Function với document/MutationObserver/setInterval giả — test
// điều khiển từng nhịp tick tay để khẳng định đúng chuỗi bấm/không bấm.
// Giới hạn: cây DOM là cấu trúc hộp widget suy từ phiên dò Crisp thật
// 2026-10-27 (iframe + nút chevron "Expand" ở chân hộp); selector/class
// thật của Crisp không phơi ra được trong phiên dò — lần bấm live đầu
// tiên mới là phán quyết cuối.

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
}

/** Trang Crisp giả: sidebar > hộp Copilot (iframe + chân hộp chứa nút Expand). */
function buildPage(session = "session_1") {
  const frame = new FakeEl("iframe", { attrs: { src: `__WIDGET_ORIGIN__/index.html?session_id=${session}&website_id=ws1` } });
  const expandBtn = new FakeEl("button", { attrs: { title: "Expand" } });
  const footer = new FakeEl("div", {}, [expandBtn]);
  const box = new FakeEl("div", {}, [frame, footer]);
  const root = new FakeEl("div", {}, [box]);
  const page = {
    frame, expandBtn, footer, root,
    collapse() { if (!footer.children.includes(expandBtn)) footer.append(expandBtn); },
    expandApplied() { if (footer.children.includes(expandBtn)) footer.remove(expandBtn); },
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
  assertEquals(page.expandBtn.clickCount, 1); // autoExpandTick chạy ngay khi nạp

  page.expandApplied(); // Crisp mở lớp phủ → nút biến mất
  tick(); tick();
  assertEquals(page.expandBtn.clickCount, 1);

  page.collapse(); // người dùng bấm Close → hộp thu gọn trở lại
  tick(); tick();
  assertEquals(page.expandBtn.clickCount, 1); // không giành lại

  page.switchSession("session_2"); // chat mới, hộp thu gọn
  tick();
  assertEquals(page.expandBtn.clickCount, 2); // mở cho chat mới
});

Deno.test("expander DOM: iframe của plugin khác → không bấm gì", async () => {
  const page = buildPage("session_1");
  page.frame.setAttribute("src", "https://plugin-khac.example/widget?session_id=session_1");
  const { tick } = await loadExpander(page);
  tick(); tick();
  assertEquals(page.expandBtn.clickCount, 0);
});
