import { assertEquals } from "jsr:@std/assert@1";
import { sentimentFingerprint } from "../copilot/analyze.ts";
import { handle } from "../copilot/handler.ts";
import { makeDeps, msg, TOKEN } from "./fakes.ts";

const MSGS = [msg("user", "app vẫn trừ tiền", 1), msg("operator", "Để mình kiểm tra", 2), msg("user", "vẫn chưa hoàn", 3)];

async function runCheck(dbOver = {}, messages = MSGS) {
  const m = makeDeps({ messages, db: dbOver });
  const r = await handle({ website_id: "ws1", session_id: "session_1", action: "check" }, TOKEN, m.deps);
  assertEquals(r.status, 200);
  return r.body as { sentiment_stale: boolean; sentiment: unknown };
}

const storedRow = (input_fp: string) => ({
  input_fp, score: 40, mood: "frustrated" as const, urgency: "low" as const,
  confidence: 0.8, summary: "bản cũ", signals: [], issues: [],
});

Deno.test("check: chưa từng có sentiment mà đã có tin khách → sentiment_stale = true (panel tự phân tích khi mở)", async () => {
  const body = await runCheck();
  assertEquals(body.sentiment_stale, true);
  assertEquals(body.sentiment, null);
});

Deno.test("check: bản lưu khớp dấu vân tay tin hiện tại → sentiment_stale = false", async () => {
  const fp = await sentimentFingerprint(MSGS);
  const body = await runCheck({ getSentiment: () => Promise.resolve(storedRow(fp)) });
  assertEquals(body.sentiment_stale, false);
});

Deno.test("check: khách đã nhắn thêm (dấu vân tay lệch) → sentiment_stale = true dù đã có bản lưu", async () => {
  const body = await runCheck({ getSentiment: () => Promise.resolve(storedRow("fp-cua-luot-truoc")) });
  assertEquals(body.sentiment_stale, true);
});

Deno.test("check: không có tin khách dạng text → sentiment_stale = false (không có gì để phân tích)", async () => {
  const body = await runCheck({}, [msg("operator", "xin chào", 1)]);
  assertEquals(body.sentiment_stale, false);
});
