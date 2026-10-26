import { sha256Hex } from "../_shared/auth.ts";
import { humanTranscript } from "../_shared/context.ts";
import type { Db } from "../_shared/db.ts";
import { type Ai } from "../_shared/gemini.ts";
import { parseSentiment, SENTIMENT_SCHEMA, type Sentiment, sentimentPrompt } from "../_shared/sentiment.ts";
import type { MessageRow } from "../_shared/types.ts";
import { type LoadDeps, loadConversationFast } from "./load.ts";

/** Vì sao chưa có sentiment: chưa có tin khách để đọc, hay AI chưa sẵn sàng
 * (thiếu cấu hình task "sentiment" trên server / hết quota). Panel hiện đúng
 * thông điệp theo reason thay vì đổ hết về "chưa đủ tin nhắn". */
export type SentimentReason = "no_customer_text" | "ai_unavailable";

export interface AnalyzeResult {
  action: "analyze";
  sentiment: Sentiment | null;
  cached: boolean;
  /** Số tin của khách làm đầu vào cho dấu vân tay sentiment — panel hiện "Tính trên N tin". */
  msg_count: number;
  reason: SentimentReason | null;
}

/** Đếm tin của khách — cùng tập đầu vào mà sentimentFingerprint dùng. */
export function customerMessageCount(messages: MessageRow[]): number {
  return messages.filter((m) => m.from === "user").length;
}

/**
 * Dấu vân tay chỉ từ tin của khách: mood đổi khi khách nhắn thêm, không đổi
 * khi CS trả lời. Kèm PHIÊN BẢN của lớp phân tích: prompt/rubric/issues-spec
 * thay đổi thì tăng version, mọi dòng sentiment đã lưu tự thành stale và
 * được tính lại đúng một lần khi mở panel. Thiếu version này, kết quả của
 * prompt cũ kẹt vĩnh viễn dù code đã sửa (gốc vụ issues chép nguyên văn lời
 * khách + "sentiment không thấy update" Ethan báo 2026-10-26: dòng lưu từ
 * thời panel còn map signals thành issue, dấu vân tay tin khách không đổi
 * nên compute-on-view không bao giờ tính lại).
 * v2 (2026-10-26): issues là câu phát biểu vấn đề AI tổng hợp, không trích thô.
 */
const SENTIMENT_FP_VERSION = "v2";
export function sentimentFingerprint(messages: MessageRow[]): Promise<string> {
  const body = JSON.stringify(
    messages.filter((m) => m.from === "user").map((m) => [m.created_at, m.content]),
  );
  return sha256Hex(`sentiment-${SENTIMENT_FP_VERSION}|${body}`);
}

/**
 * Sentiment hiện tại của conversation: có cache khớp dấu vân tay thì dùng lại,
 * không thì gọi AI rồi lưu. Lỗi AI → trả bản cache cũ (nếu có) hoặc null,
 * không bao giờ làm hỏng luồng chính (check/generate).
 */
export async function resolveSentiment(
  deps: { db: Db; ai: Ai },
  websiteId: string,
  sessionId: string,
  messages: MessageRow[],
  force = false,
): Promise<{ sentiment: Sentiment | null; cached: boolean; reason: SentimentReason | null }> {
  const cached = await deps.db.getSentiment(websiteId, sessionId).catch(() => null);
  const strip = (s: Sentiment & { input_fp: string }): Sentiment => {
    const { input_fp: _fp, ...rest } = s;
    return rest;
  };
  if (!messages.some((m) => m.from === "user" && m.type === "text")) {
    return { sentiment: cached ? strip(cached) : null, cached: Boolean(cached), reason: cached ? null : "no_customer_text" };
  }
  const fp = await sentimentFingerprint(messages);
  if (!force && cached && cached.input_fp === fp) return { sentiment: strip(cached), cached: true, reason: null };
  try {
    const transcript = humanTranscript(messages, 40, true);
    const { text, model } = await deps.ai.generate("sentiment", sentimentPrompt(transcript), { schema: SENTIMENT_SCHEMA });
    const sentiment = parseSentiment(text);
    await deps.db.saveSentiment({ ...sentiment, website_id: websiteId, session_id: sessionId, input_fp: fp, model }).catch(() => {});
    return { sentiment, cached: false, reason: null };
  } catch (e) {
    console.error("sentiment failed", e);
    return { sentiment: cached ? strip(cached) : null, cached: Boolean(cached), reason: cached ? null : "ai_unavailable" };
  }
}

/** Action analyze: CS bấm "Phân tích" trong panel Ý định & Tâm trạng. */
export async function runAnalyze(
  req: { website_id: string; session_id: string; force: boolean },
  deps: LoadDeps & { ai: Ai },
): Promise<AnalyzeResult> {
  const { conv, messages } = await loadConversationFast(deps, req.website_id, req.session_id);
  void conv;
  const { sentiment, cached, reason } = await resolveSentiment(deps, req.website_id, req.session_id, messages, req.force);
  return { action: "analyze", sentiment, cached, msg_count: customerMessageCount(messages), reason };
}
