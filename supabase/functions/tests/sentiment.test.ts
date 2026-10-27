import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { looksVietnamese, parseSentiment, sentimentGuidance, sentimentPrompt, vietnamizeSentiment } from "../_shared/sentiment.ts";
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

Deno.test("sentimentPrompt: model viết bằng ngôn ngữ tự nhiên của khách, KHÔNG ép tiếng Việt trong prompt phân tích (pipeline mới 2026-10-27)", () => {
  const p = sentimentPrompt("User: still not resolved");
  assertStringIncludes(p, "SAME language the customer uses");
  assertStringIncludes(p, "do NOT translate anything yourself");
  assertEquals(p.includes("ALWAYS Vietnamese"), false);
});

Deno.test("looksVietnamese: phân biệt tiếng Việt / tiếng Anh / chữ ngoài Latin", () => {
  assertEquals(looksVietnamese("Khách bị trừ tiền sau khi gỡ app"), true);
  // Tiếng Việt KHÔNG dấu không nhận diện được chắc chắn (dễ nhầm với ngôn
  // ngữ Latin khác) → coi là chưa, để bước dịch xử lý: an toàn hơn bỏ sót
  // một câu tiếng Anh/ngôn ngữ khác không được dịch.
  assertEquals(looksVietnamese("Khach chua nhan duoc tien hoan"), false);
  assertEquals(looksVietnamese("Charged after uninstalling the app"), false);
  assertEquals(looksVietnamese("لم يصل الاسترداد بعد"), false); // tiếng Ả Rập
  assertEquals(looksVietnamese(""), true); // rỗng = không cần dịch
});

Deno.test("vietnamizeSentiment: phân tích tiếng Anh → dịch gộp 1 lượt sang tiếng Việt, đủ summary/signals/issues", async () => {
  const f = fakeAi({
    translate: JSON.stringify({
      items: [
        { i: 0, vi: "Khách bực vì vẫn bị trừ tiền" },
        { i: 1, vi: "vẫn bị trừ tiền sau khi gỡ app" },
        { i: 2, vi: "Bị trừ tiền sau khi đã gỡ app" },
        { i: 3, vi: "đã gỡ app từ tháng 4" },
      ],
    }),
  });
  const out = await vietnamizeSentiment(f.ai, {
    score: 25, mood: "frustrated", urgency: "medium", confidence: 0.8,
    summary: "Customer angry about still being charged",
    signals: ["still charged after uninstalling"],
    issues: [{ summary: "Charged after uninstalling the app", evidence: "deleted it in April" }],
  });
  assertEquals(out.summary, "Khách bực vì vẫn bị trừ tiền");
  assertEquals(out.signals, ["vẫn bị trừ tiền sau khi gỡ app"]);
  assertEquals(out.issues, [{ summary: "Bị trừ tiền sau khi đã gỡ app", evidence: "đã gỡ app từ tháng 4" }]);
  assertEquals(f.calls.filter((c) => c.task === "translate").length, 1);
  assertEquals(out.score, 25); // trục số/mood không đổi
});

Deno.test("vietnamizeSentiment: đã tiếng Việt thì bỏ qua, không tốn lượt dịch", async () => {
  const f = fakeAi({}); // không có reply translate: gọi là reject ngay
  const s = {
    score: 50, mood: "neutral" as const, urgency: "low" as const, confidence: 0.5,
    summary: "Khách đang chờ phản hồi", signals: ["chưa rõ giới hạn dịch thuật"], issues: [],
  };
  assertEquals(await vietnamizeSentiment(f.ai, s), s);
  assertEquals(f.calls.length, 0);
});

Deno.test("vietnamizeSentiment: dịch lỗi thì giữ nguyên bản phân tích, không làm mất sentiment", async () => {
  const f = fakeAi({ translate: new Error("quota") });
  const s = {
    score: 25, mood: "frustrated" as const, urgency: "medium" as const, confidence: 0.8,
    summary: "Customer angry about still being charged", signals: [], issues: [],
  };
  assertEquals(await vietnamizeSentiment(f.ai, s), s);
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

Deno.test("sentimentFingerprint: đổi khi khách nhắn thêm VÀ khi CS trả lời thêm (issues tính lại sau khi CS đã trả lời)", async () => {
  const base = [msg({ content: "help" })];
  const fp1 = await sentimentFingerprint(base);
  const fp2 = await sentimentFingerprint([...base, msg({ from: "operator", content: "sure", created_at: "2026-01-01T00:01:00Z" })]);
  const fp3 = await sentimentFingerprint([...base, msg({ content: "still broken", created_at: "2026-01-01T00:02:00Z" })]);
  assert(fp1 !== fp2);
  assert(fp1 !== fp3);
});
