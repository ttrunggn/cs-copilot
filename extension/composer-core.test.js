import { assertEquals } from "jsr:@std/assert@1";
import { accessibleName, activateControl, confirmNoteMode, createExpandTracker, decideInsert, elHasClass, EXPAND_CONTROL_CLASS, fillVerified, findExpandButton, isCopilotMessage, isExpandActionable, isWidgetIframe, isYellowishColor, placeholderKind, sessionFromUrl, signalTrace, tabLooksActive, textsMatch, verifyWritten, widgetSessionFromSrc } from "./composer-core.js";

Deno.test("sessionFromUrl reads the open conversation", () => {
  assertEquals(sessionFromUrl("https://app.crisp.chat/website/ws1/inbox/session_abc-123/"), "session_abc-123");
  assertEquals(sessionFromUrl("https://app.crisp.chat/website/ws1/inbox/"), null);
});

const cmd = (over = {}) => ({ output_id: 7, session_id: "session_1", text: "Hello there", mode: "auto", ...over });
const base = { urlSession: "session_1", composerText: "", insertedIds: new Set() };

Deno.test("different conversation → session_mismatch", () => {
  assertEquals(decideInsert({ ...base, urlSession: "session_2", cmd: cmd() }), { status: "session_mismatch" });
});

Deno.test("auto mode with an already inserted output → duplicate", () => {
  assertEquals(decideInsert({ ...base, insertedIds: new Set([7]), cmd: cmd() }), { status: "duplicate" });
});

Deno.test("auto mode with text in the composer → not_empty", () => {
  assertEquals(decideInsert({ ...base, composerText: "đang gõ dở", cmd: cmd() }), { status: "not_empty" });
});

Deno.test("auto mode into an empty composer inserts the draft", () => {
  assertEquals(decideInsert({ ...base, composerText: "  \n", cmd: cmd() }), { status: "inserted", text: "Hello there" });
});

Deno.test("replace overrides duplicate and existing text", () => {
  assertEquals(
    decideInsert({ ...base, composerText: "old", insertedIds: new Set([7]), cmd: cmd({ mode: "replace" }) }),
    { status: "inserted", text: "Hello there" },
  );
});

Deno.test("append keeps the agent's text and adds the draft below", () => {
  assertEquals(
    decideInsert({ ...base, composerText: "Hi Anna,", cmd: cmd({ mode: "append" }) }),
    { status: "inserted", text: "Hi Anna,\n\nHello there" },
  );
});

Deno.test("isCopilotMessage only accepts copilot:* messages from the same window", () => {
  const win = {};
  assertEquals(isCopilotMessage({ source: win, data: { type: "copilot:ping" } }, win), true);
  assertEquals(isCopilotMessage({ source: {}, data: { type: "copilot:ping" } }, win), false);
  assertEquals(isCopilotMessage({ source: win, data: { type: "other" } }, win), false);
  assertEquals(isCopilotMessage({ source: win, data: null }, win), false);
});

Deno.test("isYellowishColor nhận nền vàng Note mode, loại trắng/xám/tối của Reply mode", () => {
  assertEquals(isYellowishColor("rgb(255, 249, 196)"), true); // vàng nhạt kiểu Crisp note
  assertEquals(isYellowishColor("rgba(250, 230, 140, 1)"), true);
  assertEquals(isYellowishColor("rgb(146, 124, 32)"), true); // vàng sẫm (dark mode)
  assertEquals(isYellowishColor("rgb(58, 53, 32)"), true); // vàng olive sẫm trên giao diện tối (đòi r>=120 thì trượt ca này)
  assertEquals(isYellowishColor("rgb(255, 255, 255)"), false);
  assertEquals(isYellowishColor("rgb(24, 24, 27)"), false);
  assertEquals(isYellowishColor("rgb(20, 24, 36)"), false); // nền tối ngả xanh của ô Reply (giao diện tối) — lạnh, không ấm
  assertEquals(isYellowishColor("rgb(120, 120, 120)"), false);
  assertEquals(isYellowishColor("transparent"), false);
  assertEquals(isYellowishColor(""), false);
});

Deno.test("placeholderKind nhận diện placeholder render thật của hai mode", () => {
  assertEquals(placeholderKind("Send a private note to your team…"), "note");
  assertEquals(placeholderKind("  Send a private note…"), "note");
  assertEquals(placeholderKind("Send your message to trung nguyen in chat…"), "reply");
  assertEquals(placeholderKind("Write a private note…"), null); // chỉ là dự phòng thuộc tính, không phải chữ render chuẩn
  assertEquals(placeholderKind(""), null);
  assertEquals(placeholderKind(null), null);
});

Deno.test("verifyWritten: ô phải chứa dòng đầu của nội dung vừa ghi", () => {
  assertEquals(verifyWritten("Hi there, thanks…\n\nBody", "Hi there, thanks…\n\nBody"), true);
  assertEquals(verifyWritten("", "Hi there"), false);
  assertEquals(verifyWritten("nội dung khác hẳn", "Hi there"), false);
  assertEquals(verifyWritten("Hi there", "  \nHi there"), true); // dòng đầu bỏ qua dòng trống
  assertEquals(verifyWritten("bất cứ", ""), false);
});

Deno.test("textsMatch: so TOÀN VĂN sau khi điền — bắt được lỗi dán chồng làm nội dung lặp, dung sai khác biệt render vô hại", () => {
  const draft = "Hi,\n\nThis is Sam from Transcy.\n\nHow can I help you today?";
  assertEquals(textsMatch(draft, draft), true);
  // Bản cũ còn nguyên + bản mới dán thêm → verifyWritten
  // cho qua (dòng đầu tồn tại), textsMatch phải bắt được.
  assertEquals(textsMatch(`Nội dung cũ của CS\n\n${draft}`, draft), false);
  assertEquals(textsMatch(`${draft}\n\n${draft}`, draft), false);
  assertEquals(textsMatch(draft.replace("today?", "today?Hi,"), draft), false); // dán dính vào giữa câu
  // Dung sai: khoảng trắng cuối dòng, zero-width, 3+ dòng trống gộp, xuống dòng thừa ở cuối.
  assertEquals(textsMatch("Hi,  \n\n\nThis is Sam from Transcy.\n\nHow can I help you today?\n", draft), true);
  assertEquals(textsMatch(draft.replace("Hi,", "Hi,\u200B"), draft), true);
  assertEquals(textsMatch("", draft), false);
  assertEquals(textsMatch(draft, ""), false);
});

Deno.test("tabLooksActive qua aria-selected / data-state / class", () => {
  assertEquals(tabLooksActive({ ariaSelected: "true" }), true);
  assertEquals(tabLooksActive({ ariaSelected: "false" }), false);
  assertEquals(tabLooksActive({ dataState: "active" }), true);
  assertEquals(tabLooksActive({ className: "c-tab c-tab--is-active" }), true);
  assertEquals(tabLooksActive({ className: "tab selected" }), true);
  assertEquals(tabLooksActive({ className: "tab inactive" }), false); // không khớp nhầm "inactive"
  assertEquals(tabLooksActive({ className: "tab" }), false);
  assertEquals(tabLooksActive({}), false);
});

Deno.test("confirmNoteMode: tab active + 1 tín hiệu editor, HOẶC 2 tín hiệu editor độc lập (class tab trên Crisp thật là chuỗi băm — không đọc được active)", () => {
  assertEquals(confirmNoteMode({ tabActive: true, yellowBg: true }), true);
  assertEquals(confirmNoteMode({ tabActive: true, noteClass: true }), true);
  assertEquals(confirmNoteMode({ tabActive: true, notePlaceholder: true }), true);
  assertEquals(confirmNoteMode({ tabActive: true }), false); // chỉ tab active, editor chưa đổi → chưa tin
  assertEquals(confirmNoteMode({ yellowBg: true }), false); // MỘT tín hiệu editor đơn lẻ → chưa tin
  assertEquals(confirmNoteMode({ notePlaceholder: true }), false);
  // Hai tín hiệu phía editor cùng lúc: chỉ tồn tại ở Note mode → đủ tin dù tab không đọc được trạng thái active
  assertEquals(confirmNoteMode({ notePlaceholder: true, notePill: true }), true);
  assertEquals(confirmNoteMode({ notePlaceholder: true, yellowBg: true }), true);
  assertEquals(confirmNoteMode({ notePill: true, yellowBg: true }), true);
  assertEquals(confirmNoteMode({}), false);
  assertEquals(confirmNoteMode(), false);
});

Deno.test("fillVerified: gập khoảng trắng — innerText nối đoạn bằng \\n đơn vẫn khớp; gấp đôi thật thì không", () => {
  const expected = "Hi there,\n\nThank you so much!\n\nBelow is the link:";
  assertEquals(fillVerified("Hi there,\nThank you so much!\nBelow is the link:", expected), true);
  assertEquals(fillVerified(expected, expected), true);
  assertEquals(fillVerified(`${expected}\n${expected}`, expected), false); // gấp đôi
  assertEquals(fillVerified("", expected), false);
  assertEquals(fillVerified("Hi there, Thank you!", ""), false);
});

Deno.test("signalTrace: định dạng gọn 5 tín hiệu Note mode", () => {
  assertEquals(signalTrace({ tabActive: true, yellowBg: true, noteClass: false, notePlaceholder: true, notePill: false }), "tab1 yel1 cls0 ph1 pil0");
  assertEquals(signalTrace({}), "tab0 yel0 cls0 ph0 pil0");
  assertEquals(signalTrace(), "tab0 yel0 cls0 ph0 pil0");
});

Deno.test("decideInsert: ô còn nguyên bản copilot tự điền trước đó → thay luôn, không hỏi; người đã sửa thì vẫn hỏi", () => {
  const prev = "Hi,\n\nThis is Sam from the Transcy Customer Support team.";
  // Ô chứa đúng bản copilot đã điền (chưa ai đụng vào) → inserted thẳng.
  assertEquals(
    decideInsert({ ...base, composerText: prev, lastFilledText: prev, cmd: cmd({ text: "Bản mới" }) }),
    { status: "inserted", text: "Bản mới" },
  );
  // Người đã sửa thêm một câu → không còn là bản copilot nguyên văn → hỏi.
  assertEquals(
    decideInsert({ ...base, composerText: prev + "\n\nCâu CS tự thêm.", lastFilledText: prev, cmd: cmd() }),
    { status: "not_empty" },
  );
  // Không có lastFilledText (bản extension cũ) → hành vi cũ: hỏi.
  assertEquals(decideInsert({ ...base, composerText: prev, cmd: cmd() }), { status: "not_empty" });
});

Deno.test("fillVerified: dòng đánh số bị editor biến thành marker danh sách (innerText mất '1. ') vẫn khớp", () => {
  const expected = "Handoff — Test Agent\nKhách hàng yêu cầu gặp nhân viên hỗ trợ trực tiếp.\n1. Yêu cầu kết nối với nhân viên hỗ trợ — Đang xử lý: Bot đã ghi nhận yêu cầu.\n\nTiếp theo (chờ CS): Tiếp nhận hội thoại ngay.";
  const readBackNoMarker = expected.replace("\n1. Yêu cầu", "\nYêu cầu");
  assertEquals(fillVerified(readBackNoMarker, expected), true);
  assertEquals(fillVerified(expected, expected), true);
  // Thiếu hẳn đoạn cuối → vẫn bắt được, dung sai không nuốt lỗi thật.
  const missingTail = "Handoff — Test Agent\nKhách hàng yêu cầu gặp nhân viên hỗ trợ trực tiếp.\nYêu cầu kết nối với nhân viên hỗ trợ — Đang xử lý: Bot đã ghi nhận yêu cầu.";
  assertEquals(fillVerified(missingTail, expected), false);
  // Nội dung khác hẳn → false.
  assertEquals(fillVerified("Một nội dung hoàn toàn khác không liên quan gì tới bản kỳ vọng cả.", expected), false);
});

// ─── Tự mở rộng hộp widget ──────────────────────────────────────────────────

function fakeEl(tag, opts = {}, kids = []) {
  const e = {
    tagName: String(tag).toUpperCase(),
    attrs: opts.attrs ?? {},
    text: opts.text ?? "",
    parentElement: null,
    children: kids,
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); },
    querySelectorAll() { const out = []; const rec = (n) => { for (const c of n.children) { out.push(c); rec(c); } }; rec(this); return out; },
  };
  for (const k of kids) k.parentElement = e;
  return e;
}

Deno.test("accessibleName: aria-label thắng title/text, chuẩn hoá hoa thường + khoảng trắng", () => {
  assertEquals(accessibleName(fakeEl("button", { attrs: { "aria-label": "  Expand ", title: "Khác" }, text: "Khác nữa" })), "expand");
  assertEquals(accessibleName(fakeEl("button", { attrs: { title: "Expand" } })), "expand");
  assertEquals(accessibleName(fakeEl("button", { text: "Thu   gọn" })), "thu gọn");
});

Deno.test("isWidgetIframe + widgetSessionFromSrc", () => {
  const f = fakeEl("iframe", { attrs: { src: "https://copilot-oe.netlify.app/index.html?session_id=session_9&website_id=ws1" } });
  assertEquals(isWidgetIframe(f, "https://copilot-oe.netlify.app"), true);
  assertEquals(isWidgetIframe(f, "https://khac.example"), false);
  assertEquals(isWidgetIframe(fakeEl("div", { attrs: { src: "https://copilot-oe.netlify.app/x" } }), "https://copilot-oe.netlify.app"), false);
  assertEquals(widgetSessionFromSrc(f.attrs.src), "session_9");
  assertEquals(widgetSessionFromSrc("https://copilot-oe.netlify.app/index.html"), null);
});

/** Dựng hộp widget: sidebar > [hộp khác có nút Expand riêng] + [hộp mình: iframe + footer]. */
function widgetBox({ expandButtons = 1, otherBoxExpand = true } = {}) {
  const frame = fakeEl("iframe", { attrs: { src: "https://copilot-oe.netlify.app/index.html?session_id=session_1" } });
  const btns = Array.from({ length: expandButtons }, () => fakeEl("button", { attrs: { title: "Expand" } }));
  const footer = fakeEl("div", {}, btns);
  const box = fakeEl("div", {}, [frame, footer]);
  const otherBtn = fakeEl("button", { attrs: { "aria-label": "Expand" } });
  const otherFrame = fakeEl("iframe", { attrs: { src: "https://plugin-khac.example/widget" } });
  const otherBox = fakeEl("div", {}, otherBoxExpand ? [otherFrame, otherBtn] : [otherFrame]);
  fakeEl("div", {}, [otherBox, box]); // sidebar — gán parentElement qua constructor
  return { frame, btns, otherBtn };
}

Deno.test("findExpandButton: nút ở chân hộp của mình", () => {
  const { frame, btns } = widgetBox();
  assertEquals(findExpandButton(frame), btns[0]);
});

Deno.test("findExpandButton: không có nút Expand trong hộp → null (không leo sang hộp khác)", () => {
  const { frame } = widgetBox({ expandButtons: 0 });
  assertEquals(findExpandButton(frame), null);
});

Deno.test("findExpandButton: 2 nút Expand cùng phạm vi → null, không bấm đoán", () => {
  const { frame } = widgetBox({ expandButtons: 2 });
  assertEquals(findExpandButton(frame), null);
});

Deno.test("findExpandButton: DOM Crisp thật — span Expand theo class (không phải button), trả đúng span đó", () => {
  const frame = fakeEl("iframe", { attrs: { src: "https://copilot-oe.netlify.app/index.html?session_id=session_1" } });
  const icon = fakeEl("svg", { attrs: { class: "c-base-icon c-conversation-profile-widget__expand-icon" } });
  const span = fakeEl("span", { attrs: { class: "c-conversation-profile-widget__expand u-has-tooltip" } }, [icon]);
  const body = fakeEl("div", { attrs: { class: "c-conversation-profile-widget__body" } }, [span]);
  fakeEl("div", {}, [fakeEl("div", {}, [frame, body])]);
  assertEquals(findExpandButton(frame), span);
  assertEquals(elHasClass(span, EXPAND_CONTROL_CLASS), true);
  assertEquals(elHasClass(icon, EXPAND_CONTROL_CLASS), false);
});

Deno.test("isExpandActionable: tâm nút bị iframe phủ (đã mở rộng) → false; còn trống → true; thiếu API đo → true", () => {
  const rect = { left: 0, top: 0, width: 100, height: 24 };
  const mk = (hit) => {
    const el = {
      getBoundingClientRect: () => rect,
      contains: (n) => n === "child",
      ownerDocument: { elementFromPoint: () => hit },
    };
    return el;
  };
  const self = mk(null);
  self.ownerDocument.elementFromPoint = () => self;
  assertEquals(isExpandActionable(self), true);
  assertEquals(isExpandActionable(mk("child")), true);
  assertEquals(isExpandActionable(mk({ tagName: "IFRAME" })), false);
  assertEquals(isExpandActionable({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }), false);
  assertEquals(isExpandActionable({}), true);
  assertEquals(isExpandActionable(null), false);
});

Deno.test("activateControl: phát mousedown/mouseup/click lên svg con; phần tử không dispatchEvent thì .click()", () => {
  globalThis.MouseEvent ??= class {
    constructor(type, opts = {}) { this.type = type; Object.assign(this, opts); }
  };
  const seen = [];
  const svg = { dispatchEvent: (e) => { seen.push(e.type); return true; } };
  activateControl({ querySelectorAll: () => [svg], click: () => seen.push("span-click") });
  assertEquals(seen, ["mousedown", "mouseup", "click"]);
  let clicks = 0;
  activateControl({ querySelectorAll: () => [], click: () => clicks++ });
  assertEquals(clicks, 1);
});

Deno.test("expand tracker: bấm 1 lần/phiên; người đóng tay thì phiên đó không mở lại; sang phiên mới thì mở", () => {
  const t = createExpandTracker();
  assertEquals(t.observe("s1", true), true); // lần đầu thấy nút → bấm
  t.noteClicked();
  assertEquals(t.observe("s1", true), false); // nút chưa kịp biến mất
  assertEquals(t.observe("s1", false), false); // lớp phủ đang mở
  assertEquals(t.observe("s1", false), false);
  assertEquals(t.observe("s1", true), false); // nút quay lại = người vừa đóng → thôi hẳn
  assertEquals(t.observe("s1", true), false);
  assertEquals(t.observe("s2", true), true); // phiên mới → mở lại
});

Deno.test("expand tracker: lớp phủ mang sang từ phiên trước — người đóng là hết, không bật lại", () => {
  const t = createExpandTracker();
  assertEquals(t.observe("s1", false), false); // vào phiên đã ở trạng thái mở sẵn
  assertEquals(t.observe("s1", false), false);
  assertEquals(t.observe("s1", true), false); // người đóng → không tự mở lại
});

Deno.test("expand tracker: nút vắng mặt thoáng qua 1 nhịp không bị hiểu nhầm là đã mở", () => {
  const t = createExpandTracker();
  assertEquals(t.observe("s1", false), false); // DOM chưa dựng xong
  assertEquals(t.observe("s1", true), true);
});

Deno.test("expand tracker: bấm trượt (nút còn nguyên) → cho bấm lại sau 6 nhịp", () => {
  const t = createExpandTracker();
  assertEquals(t.observe("s1", true), true);
  t.noteClicked();
  for (let i = 0; i < 5; i++) assertEquals(t.observe("s1", true), false);
  assertEquals(t.observe("s1", true), true); // nhịp thứ 6 sau lần bấm trượt
});
