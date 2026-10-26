import { assertEquals } from "jsr:@std/assert@1";
import { sentimentFingerprint } from "../copilot/analyze.ts";
import { handlePrecompute, runPrecompute } from "../copilot/precompute.ts";
import { fakeAi, makeDeps, msg } from "./fakes.ts";

const SENTIMENT_JSON = JSON.stringify({
  score: 35, mood: "frustrated", urgency: "high", confidence: 0.9,
  summary: "Khách bực vì bị trừ tiền hai lần", signals: ["trừ tiền 2 lần"],
});
const MSGS = [msg("user", "Tôi bị trừ tiền 2 lần!", 1), msg("operator", "Để mình kiểm tra", 2)];

Deno.test("precompute: tính sentiment từ tin trong DB và lưu lại", async () => {
  const saved: unknown[] = [];
  const { deps } = makeDeps({
    messages: MSGS,
    ai: fakeAi({ sentiment: SENTIMENT_JSON }).ai,
    db: { saveSentiment: (row) => (saved.push(row), Promise.resolve()) },
  });
  const r = await runPrecompute(deps, "ws1", "session_1");
  assertEquals(r, { sentiment: true, cached: false, skipped: null });
  assertEquals(saved.length, 1);
  assertEquals((saved[0] as { score: number }).score, 35);
});

Deno.test("precompute: dấu vân tay khớp thì dùng cache, không gọi AI lại", async () => {
  const fp = await sentimentFingerprint(MSGS);
  const f = fakeAi({}); // bất kỳ lượt gọi AI nào cũng nổ — chứng minh không gọi
  const { deps } = makeDeps({
    messages: MSGS,
    ai: f.ai,
    db: {
      getSentiment: () => Promise.resolve({
        input_fp: fp, score: 35, mood: "frustrated" as const, urgency: "high" as const,
        confidence: 0.9, summary: "s", signals: [], issues: [],
      }),
    },
  });
  const r = await runPrecompute(deps, "ws1", "session_1");
  assertEquals(r, { sentiment: true, cached: true, skipped: null });
  assertEquals(f.calls.length, 0);
});

Deno.test("precompute: workspace lạ thì bỏ qua, không lỗi", async () => {
  const { deps } = makeDeps({ db: { getWorkspace: () => Promise.resolve(null) } });
  const r = await runPrecompute(deps, "ws-la", "session_1");
  assertEquals(r.skipped, "unknown_workspace");
});

Deno.test("precompute: conversation chưa có tin thì bỏ qua", async () => {
  const { deps } = makeDeps({ messages: [] });
  const r = await runPrecompute(deps, "ws1", "session_1");
  assertEquals(r.skipped, "no_messages");
});

Deno.test("precompute: chưa có tin khách thì không có sentiment nhưng không lỗi", async () => {
  const { deps } = makeDeps({ messages: [msg("operator", "Chào bạn", 1)], ai: fakeAi({}).ai });
  const r = await runPrecompute(deps, "ws1", "session_1");
  assertEquals(r.sentiment, false);
  assertEquals(r.skipped, "no_customer_text");
});

Deno.test("handlePrecompute: body thiếu trường thì 400, đủ thì 200", async () => {
  const { deps } = makeDeps({ messages: MSGS, ai: fakeAi({ sentiment: SENTIMENT_JSON }).ai });
  const bad = await handlePrecompute({ action: "precompute_sentiment" }, deps);
  assertEquals(bad.status, 400);
  const ok = await handlePrecompute({ website_id: "ws1", session_id: "session_1" }, deps);
  assertEquals(ok.status, 200);
  assertEquals((ok.body as { sentiment: boolean }).sentiment, true);
});
