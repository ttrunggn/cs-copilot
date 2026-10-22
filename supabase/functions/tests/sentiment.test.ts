import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parseSentiment, sentimentGuidance, sentimentPrompt } from "../_shared/sentiment.ts";
import { sentimentFingerprint } from "../copilot/analyze.ts";
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
  const g = sentimentGuidance({ score: 20, mood: "frustrated", urgency: "low", confidence: 0.9, summary: "", signals: [] });
  assertStringIncludes(g, "no emoji anywhere");
  assertStringIncludes(g, "Never ask for a review");
  const calm = sentimentGuidance({ score: 50, mood: "neutral", urgency: "low", confidence: 0.9, summary: "", signals: [] });
  assertEquals(calm, "");
});

Deno.test("sentimentFingerprint: chỉ đổi khi khách nhắn, CS trả lời không đổi", async () => {
  const base = [msg({ content: "help" })];
  const fp1 = await sentimentFingerprint(base);
  const fp2 = await sentimentFingerprint([...base, msg({ from: "operator", content: "sure", created_at: "2026-01-01T00:01:00Z" })]);
  const fp3 = await sentimentFingerprint([...base, msg({ content: "still broken", created_at: "2026-01-01T00:02:00Z" })]);
  assertEquals(fp1, fp2);
  assert(fp1 !== fp3);
});
