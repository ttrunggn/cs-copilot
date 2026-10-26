import { assertEquals } from "jsr:@std/assert@1";
import { confirmNoteMode, decideInsert, fillVerified, isCopilotMessage, isYellowishColor, placeholderKind, sessionFromUrl, signalTrace, tabLooksActive, textsMatch, verifyWritten } from "./composer-core.js";

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
  assertEquals(isYellowishColor("rgb(58, 53, 32)"), true); // vàng olive sẫm trên giao diện tối — phiên dò 2026-10-26 (bản cũ đòi r>=120 nên trượt ca này)
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
  const draft = "Hi,\n\nThis is Ethan from Transcy.\n\nHow can I help you today?";
  assertEquals(textsMatch(draft, draft), true);
  // Lỗi live 2026-10-26: bản cũ còn nguyên + bản mới dán thêm → verifyWritten
  // cũ cho qua (dòng đầu tồn tại), textsMatch phải bắt được.
  assertEquals(textsMatch(`Nội dung cũ của CS\n\n${draft}`, draft), false);
  assertEquals(textsMatch(`${draft}\n\n${draft}`, draft), false);
  assertEquals(textsMatch(draft.replace("today?", "today?Hi,"), draft), false); // dán dính vào giữa câu
  // Dung sai: khoảng trắng cuối dòng, zero-width, 3+ dòng trống gộp, xuống dòng thừa ở cuối.
  assertEquals(textsMatch("Hi,  \n\n\nThis is Ethan from Transcy.\n\nHow can I help you today?\n", draft), true);
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
  assertEquals(fillVerified(`${expected}\n${expected}`, expected), false); // gấp đôi — ca live 2026-10-26
  assertEquals(fillVerified("", expected), false);
  assertEquals(fillVerified("Hi there, Thank you!", ""), false);
});

Deno.test("signalTrace: định dạng gọn 5 tín hiệu Note mode", () => {
  assertEquals(signalTrace({ tabActive: true, yellowBg: true, noteClass: false, notePlaceholder: true, notePill: false }), "tab1 yel1 cls0 ph1 pil0");
  assertEquals(signalTrace({}), "tab0 yel0 cls0 ph0 pil0");
  assertEquals(signalTrace(), "tab0 yel0 cls0 ph0 pil0");
});
