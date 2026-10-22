import { sha256Hex } from "../_shared/auth.ts";
import { humanTranscript } from "../_shared/context.ts";
import type { Db } from "../_shared/db.ts";
import { type Ai } from "../_shared/gemini.ts";
import { parseSentiment, SENTIMENT_SCHEMA, type Sentiment, sentimentPrompt } from "../_shared/sentiment.ts";
import type { MessageRow } from "../_shared/types.ts";
import { type LoadDeps, loadConversationFast } from "./load.ts";

export interface AnalyzeResult {
  action: "analyze";
  sentiment: Sentiment | null;
  cached: boolean;
}

/** Dấu vân tay chỉ từ tin của khách: mood đổi khi khách nhắn thêm, không đổi khi CS trả lời. */
export function sentimentFingerprint(messages: MessageRow[]): Promise<string> {
  const body = JSON.stringify(
    messages.filter((m) => m.from === "user").map((m) => [m.created_at, m.content]),
  );
  return sha256Hex(`sentiment|${body}`);
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
): Promise<{ sentiment: Sentiment | null; cached: boolean }> {
  const cached = await deps.db.getSentiment(websiteId, sessionId).catch(() => null);
  const strip = (s: Sentiment & { input_fp: string }): Sentiment => {
    const { input_fp: _fp, ...rest } = s;
    return rest;
  };
  if (!messages.some((m) => m.from === "user" && m.type === "text")) {
    return { sentiment: cached ? strip(cached) : null, cached: Boolean(cached) };
  }
  const fp = await sentimentFingerprint(messages);
  if (!force && cached && cached.input_fp === fp) return { sentiment: strip(cached), cached: true };
  try {
    const transcript = humanTranscript(messages, 40, true);
    const { text, model } = await deps.ai.generate("sentiment", sentimentPrompt(transcript), { schema: SENTIMENT_SCHEMA });
    const sentiment = parseSentiment(text);
    await deps.db.saveSentiment({ ...sentiment, website_id: websiteId, session_id: sessionId, input_fp: fp, model }).catch(() => {});
    return { sentiment, cached: false };
  } catch (e) {
    console.error("sentiment failed", e);
    return { sentiment: cached ? strip(cached) : null, cached: Boolean(cached) };
  }
}

/** Action analyze: CS bấm "Phân tích" trong panel Ý định & Tâm trạng. */
export async function runAnalyze(
  req: { website_id: string; session_id: string; force: boolean },
  deps: LoadDeps & { ai: Ai },
): Promise<AnalyzeResult> {
  const { conv, messages } = await loadConversationFast(deps, req.website_id, req.session_id);
  void conv;
  const { sentiment, cached } = await resolveSentiment(deps, req.website_id, req.session_id, messages, req.force);
  return { action: "analyze", sentiment, cached };
}
