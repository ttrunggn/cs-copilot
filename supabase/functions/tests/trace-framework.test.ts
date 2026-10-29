// Khung truy vết (migration 032): flow_id dùng chung mọi stage, mã lỗi chuẩn
// hoá, và lịch sử đo sentiment append-only (chỉ ghi khi tính mới).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import type { Db, SentimentHistoryRow, TraceRow } from "../_shared/db.ts";
import { FlowTracer, newFlowId, TRACE_ERROR_CODES } from "../_shared/trace.ts";
import { resolveSentiment, sentimentFingerprint } from "../copilot/analyze.ts";
import { fakeAi, makeDeps, msg } from "./fakes.ts";

Deno.test("newFlowId: tiền tố action + duy nhất mỗi lần sinh", () => {
  const a = newFlowId("check");
  const b = newFlowId("check");
  assert(a.startsWith("check-"));
  assertNotEquals(a, b);
});

Deno.test("FlowTracer: timing và error mang cùng flow_id, error kèm mã chuẩn hoá", async () => {
  const rows: TraceRow[] = [];
  const db = { logTrace: (r: TraceRow) => (rows.push(r), Promise.resolve()) } as unknown as Db;
  const tracer = new FlowTracer(db, { website_id: "ws1", session_id: "s1", action: "generate" });
  await tracer.timing("ai_call", 123.4, { model: "gpt-6-luna" });
  await tracer.error("ai_call", "AI", "hết quota", { model: "gpt-6-luna" });
  assertEquals(rows.length, 2);
  assertEquals(rows[0].flow_id, tracer.flowId);
  assertEquals(rows[1].flow_id, tracer.flowId);
  assertEquals(rows[0].duration_ms, 123);
  assertEquals(rows[1].detail?.error_code, "AI");
  assert(TRACE_ERROR_CODES.includes("AI"));
});

Deno.test("FlowTracer: tracing hỏng (logTrace ném lỗi) vẫn không gãy luồng", async () => {
  const db = { logTrace: () => Promise.reject(new Error("bang chua co")) } as unknown as Db;
  const tracer = new FlowTracer(db, { action: "check" });
  await tracer.timing("handler", 5);
  await tracer.error("handler", "UNKNOWN", "x");
});

const SENTIMENT_JSON = JSON.stringify({
  score: 30, mood: "frustrated", urgency: "high", confidence: 0.9,
  summary: "Still charged twice and waiting", signals: ["charged twice"],
  issues: [{ summary: "Charged twice", evidence: "charged twice" }],
});
const MSGS = [msg("user", "I was charged twice!", 1), msg("operator", "Let me check", 2)];

Deno.test("resolveSentiment: tính mới thì ghi đúng 1 dòng history kèm nguồn kích hoạt", async () => {
  const history: SentimentHistoryRow[] = [];
  const { deps } = makeDeps({
    messages: MSGS,
    ai: fakeAi({ sentiment: SENTIMENT_JSON }).ai,
    db: { appendSentimentHistory: (row) => (history.push(row), Promise.resolve()) },
  });
  const r = await resolveSentiment(deps, "ws1", "session_1", MSGS, false, "precompute");
  assertEquals(r.cached, false);
  assertEquals(history.length, 1);
  assertEquals(history[0].source, "precompute");
  assertEquals(history[0].score, 30);
  assertEquals(history[0].input_fp, await sentimentFingerprint(MSGS));
});

Deno.test("resolveSentiment: cache hit thì KHÔNG ghi history (không phải lần đo mới)", async () => {
  const fp = await sentimentFingerprint(MSGS);
  const history: SentimentHistoryRow[] = [];
  const { deps } = makeDeps({
    messages: MSGS,
    ai: fakeAi({}).ai,
    db: {
      getSentiment: () => Promise.resolve({
        input_fp: fp, score: 30, mood: "frustrated" as const, urgency: "high" as const,
        confidence: 0.9, summary: "s", signals: [], issues: [],
      }),
      appendSentimentHistory: (row) => (history.push(row), Promise.resolve()),
    },
  });
  const r = await resolveSentiment(deps, "ws1", "session_1", MSGS, false, "analyze");
  assertEquals(r.cached, true);
  assertEquals(history.length, 0);
});

Deno.test("resolveSentiment: ghi history lỗi vẫn trả sentiment bình thường", async () => {
  const { deps } = makeDeps({
    messages: MSGS,
    ai: fakeAi({ sentiment: SENTIMENT_JSON }).ai,
    db: { appendSentimentHistory: () => Promise.reject(new Error("bang chua co")) },
  });
  const r = await resolveSentiment(deps, "ws1", "session_1", MSGS, false, "generate");
  assertEquals(r.sentiment?.score, 30);
});
