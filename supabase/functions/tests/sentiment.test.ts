import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parseSentiment, sentimentGuidance, sentimentPrompt } from "../_shared/sentiment.ts";
import { customerMessageCount, sentimentFingerprint } from "../copilot/analyze.ts";
import { handle } from "../copilot/handler.ts";
import { fakeAi, makeDeps, TOKEN } from "./fakes.ts";
import type { MessageRow } from "../_shared/types.ts";

function msg(p: Partial<MessageRow>): MessageRow {
  return {
    id: 1, content_en: null, from: "user", type: "text", is_bot: false,
    content: "hi", created_at: "2026-01-01T00:00:00Z", operator_name: null, ...p,
  };
}

Deno.test("parseSentiment: output hợp lệ giữ nguyên hai trục độc lập", () => {
  const s = parseSentiment(JSON.stringify({
    score: 22, mood: "frustrated", urgency: "high", confidence: 0.9, summary: "Khách bực vì lỗi chưa sửa", signals: ["still not working"],
  }));
  assertEquals(s.mood, "frustrated");
  assertEquals(s.urgency, "high"); // bản cũ không bao giờ ra được trạng thái khẩn cấp
  assertEquals(s.score, 22);
});

Deno.test("parseSentiment: thiếu mood thì suy từ điểm theo bảng neo, không ném lỗi", () => {
  assertEquals(parseSentiment('{"score":80}').mood, "happy");
  assertEquals(parseSentiment('{"score":50}').mood, "neutral");
  assertEquals(parseSentiment('{"score":95}').urgency, "low");
  assertEquals(parseSentiment("không phải json").score, 50);
});

Deno.test("sentimentPrompt: rubric có neo điểm, trục urgency riêng và ví dụ phủ định", () => {
  const p = sentimentPrompt("User: still not resolved");
  assertStringIncludes(p, "Negation flips meaning");
  assertStringIncludes(p, "urgency is a SEPARATE axis");
  assertStringIncludes(p, "still not resolved");
});

Deno.test("sentimentGuidance: khách bực/khẩn cấp thì cấm emoji và cấm xin review", () => {
  const g = sentimentGuidance({ score: 20, mood: "frustrated", urgency: "low", confidence: 0.9, summary: "", signals: [], issues: [] });
  assertStringIncludes(g, "no emoji anywhere");
  assertStringIncludes(g, "Never ask for a review");
  const calm = sentimentGuidance({ score: 50, mood: "neutral", urgency: "low", confidence: 0.9, summary: "", signals: [], issues: [] });
  assertEquals(calm, "");
});

Deno.test("parseSentiment: issues được chuẩn hoá — giữ câu tóm tắt + bằng chứng, bỏ rác, khử trùng, tối đa 3", () => {
  const s = parseSentiment(JSON.stringify({
    score: 40, issues: [
      { summary: "Khách bị trừ tiền sau khi đã gỡ app", evidence: "it is still charging" },
      { summary: "Khách bị trừ tiền sau khi đã gỡ app", evidence: "trùng" },
      { summary: "   ", evidence: "summary rỗng" },
      { evidence: "thiếu summary" },
      "không phải object",
      { summary: "Khách chờ hoàn tiền quá lâu" },
      { summary: "Khách không đăng nhập được vào store" },
      { summary: "Vấn đề thứ tư — phải bị cắt vì vượt tối đa 3" },
    ],
  }));
  assertEquals(s.issues, [
    { summary: "Khách bị trừ tiền sau khi đã gỡ app", evidence: "it is still charging" },
    { summary: "Khách chờ hoàn tiền quá lâu", evidence: "" },
    { summary: "Khách không đăng nhập được vào store", evidence: "" },
  ]);
  assertEquals(parseSentiment('{"score":50}').issues, []); // AI không trả issues → mảng rỗng, không lỗi
});

Deno.test("sentimentPrompt: có hướng dẫn issues — câu tóm tắt vấn đề, tin tiến độ không thành issue", () => {
  const p = sentimentPrompt("User: I have accepted you");
  assertStringIncludes(p, "issues");
  assertStringIncludes(p, "NOT an issue");
  assertStringIncludes(p, "problem statement");
});

Deno.test("customerMessageCount: chỉ đếm tin của khách", () => {
  const rows = [msg({}), msg({ from: "operator", content: "ok" }), msg({ content: "still broken", created_at: "2026-01-01T00:02:00Z" })];
  assertEquals(customerMessageCount(rows), 2);
  assertEquals(customerMessageCount([]), 0);
});

Deno.test("analyze trả msg_count = số tin của khách trong hội thoại", async () => {
  const f = fakeAi({
    sentiment: JSON.stringify({ score: 30, mood: "frustrated", urgency: "medium", confidence: 0.8, summary: "Khách đang bực", signals: [] }),
  });
  // makeDeps mặc định: 3 tin — khách, CS, khách → msg_count = 2.
  const m = makeDeps({ ai: f.ai });
  const r = await handle({ website_id: "ws1", session_id: "session_1", action: "analyze" }, TOKEN, m.deps);
  assertEquals(r.status, 200);
  const body = r.body as { msg_count: number; sentiment: { mood: string } | null };
  assertEquals(body.msg_count, 2);
  assertEquals(body.sentiment?.mood, "frustrated");
});

Deno.test("analyze: AI lỗi và chưa có cache → reason ai_unavailable, sentiment null", async () => {
  const f = fakeAi({});
  f.ai.generate = () => Promise.reject(new Error("no models configured"));
  const m = makeDeps({ ai: f.ai });
  const r = await handle({ website_id: "ws1", session_id: "session_1", action: "analyze" }, TOKEN, m.deps);
  assertEquals(r.status, 200);
  const body = r.body as { sentiment: unknown; reason: string | null };
  assertEquals(body.sentiment, null);
  assertEquals(body.reason, "ai_unavailable");
});

Deno.test("sentimentFingerprint: chỉ đổi khi khách nhắn, CS trả lời không đổi", async () => {
  const base = [msg({ content: "help" })];
  const fp1 = await sentimentFingerprint(base);
  const fp2 = await sentimentFingerprint([...base, msg({ from: "operator", content: "sure", created_at: "2026-01-01T00:01:00Z" })]);
  const fp3 = await sentimentFingerprint([...base, msg({ content: "still broken", created_at: "2026-01-01T00:02:00Z" })]);
  assertEquals(fp1, fp2);
  assert(fp1 !== fp3);
});
