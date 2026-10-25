import { assertEquals } from "jsr:@std/assert@1";
import { confirmNoteMode, decideInsert, isCopilotMessage, isYellowishColor, sessionFromUrl, tabLooksActive } from "./composer-core.js";

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
  assertEquals(isYellowishColor("rgb(255, 255, 255)"), false);
  assertEquals(isYellowishColor("rgb(24, 24, 27)"), false);
  assertEquals(isYellowishColor("rgb(120, 120, 120)"), false);
  assertEquals(isYellowishColor("transparent"), false);
  assertEquals(isYellowishColor(""), false);
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

Deno.test("confirmNoteMode: phải có tab active VÀ một tín hiệu phía editor — thiếu một phía là không xác nhận", () => {
  assertEquals(confirmNoteMode({ tabActive: true, yellowBg: true }), true);
  assertEquals(confirmNoteMode({ tabActive: true, noteClass: true }), true);
  assertEquals(confirmNoteMode({ tabActive: true, notePlaceholder: true }), true);
  assertEquals(confirmNoteMode({ tabActive: true }), false); // chỉ tab active, editor chưa đổi → chưa tin
  assertEquals(confirmNoteMode({ yellowBg: true }), false); // editor vàng nhưng tab chưa active → chưa tin
  assertEquals(confirmNoteMode({}), false);
  assertEquals(confirmNoteMode(), false);
});
