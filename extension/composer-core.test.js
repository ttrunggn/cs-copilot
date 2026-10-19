import { assertEquals } from "jsr:@std/assert@1";
import { decideInsert, isCopilotMessage, sessionFromUrl } from "./composer-core.js";

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
