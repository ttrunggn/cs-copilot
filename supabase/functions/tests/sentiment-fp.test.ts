import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { sentimentFingerprint } from "../copilot/analyze.ts";
import type { MessageRow } from "../_shared/types.ts";

const msg = (over: Partial<MessageRow>): MessageRow => ({
  website_id: "ws1", session_id: "s1", crisp_msg_id: null, from: "user", type: "text",
  content: "", content_en: null, operator_id: null, operator_name: null, is_bot: false,
  created_at: "2026-10-20T00:00:00Z", ...over,
} as MessageRow);

Deno.test("sentimentFingerprint: CS trả lời thêm → vân tay đổi (issues tính lại); bot/note thêm → không đổi", async () => {
  const base = [msg({ content: "app broken" })];
  const fp0 = await sentimentFingerprint(base);
  const withReply = [...base, msg({ from: "operator", content: "Fixed — here is why…", created_at: "2026-10-20T01:00:00Z" })];
  assertNotEquals(await sentimentFingerprint(withReply), fp0);
  const withBot = [...base, msg({ from: "operator", is_bot: true, content: "bot auto reply", created_at: "2026-10-20T01:00:00Z" })];
  assertEquals(await sentimentFingerprint(withBot), fp0);
  const withNote = [...base, msg({ from: "operator", type: "note", content: "internal", created_at: "2026-10-20T01:00:00Z" })];
  assertEquals(await sentimentFingerprint(withNote), fp0);
});
