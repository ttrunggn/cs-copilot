import { sha256Hex } from "../_shared/auth.ts";
import { humanTranscript } from "../_shared/context.ts";
import type { CrispClient } from "../_shared/crisp.ts";
import type { Db } from "../_shared/db.ts";
import { type Ai } from "../_shared/gemini.ts";
import { parseSentiment, SENTIMENT_SCHEMA, type Sentiment, sentimentPrompt, vietnamizeSentiment } from "../_shared/sentiment.ts";
import type { MessageRow } from "../_shared/types.ts";
import { type LoadDeps, loadConversationFast } from "./load.ts";
import { syncMoodBand } from "./mood-band.ts";

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

/** Đếm tin của khách trong conversation. */
export function customerMessageCount(messages: MessageRow[]): number {
  return messages.filter((m) => m.from === "user").length;
}

/**
 * Dấu vân tay từ tin của khách + câu TRẢ LỜI THẬT của CS (không bot, không
 * note): khách nhắn thêm thì mood tính lại, CS trả lời xong thì issues/tóm
 * tắt cũng phải tính lại — bản cũ chỉ băm tin khách nên sau khi CS đã trả
 * lời đầy đủ, panel vẫn treo issues cũ với chữ "chưa được giải quyết"
 * (Ethan báo ca live 2026-10-26). Kèm PHIÊN BẢN của lớp phân tích:
 * prompt/rubric/issues-spec thay đổi thì tăng version, mọi dòng sentiment
 * đã lưu tự thành stale và được tính lại đúng một lần khi mở panel.
 * v2 (2026-10-26): issues là câu phát biểu vấn đề AI tổng hợp, không trích thô.
 * v3 (2026-10-26): băm cả tin CS trả lời; issues loại vấn đề CS đã trả lời.
 * v4 (2026-10-27): pipeline đổi — model phân tích bằng ngôn ngữ tự nhiên của
 * khách rồi dịch kết quả sang tiếng Việt (vietnamizeSentiment), thay cho ép
 * xuất tiếng Việt ngay trong prompt phân tích.
 */
const SENTIMENT_FP_VERSION = "v4";
export function sentimentFingerprint(messages: MessageRow[]): Promise<string> {
  const body = JSON.stringify(
    messages
      .filter((m) => m.from === "user" || (m.from === "operator" && !m.is_bot && m.type === "text"))
      .map((m) => [m.from, m.created_at, m.content]),
  );
  return sha256Hex(`sentiment-${SENTIMENT_FP_VERSION}|${body}`);
}

/**
 * Sentiment hiện tại của conversation: có cache khớp dấu vân tay thì dùng lại,
 * không thì gọi AI rồi lưu. Lỗi AI → trả bản cache cũ (nếu có) hoặc null,
 * không bao giờ làm hỏng luồng chính (check/generate).
 */
/** Nguồn kích hoạt một lần đo sentiment — ghi vào sentiment_history (migration 032) để truy vết được đo khi nào, từ luồng nào. */
export type SentimentSource = "analyze" | "precompute" | "generate" | "unknown";

export async function resolveSentiment(
  deps: { db: Db; ai: Ai; crisp?: CrispClient | null; syncBand?: boolean },
  websiteId: string,
  sessionId: string,
  messages: MessageRow[],
  force = false,
  source: SentimentSource = "unknown",
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
    const sentiment = await vietnamizeSentiment(deps.ai, parseSentiment(text));
    await deps.db.saveSentiment({ ...sentiment, website_id: websiteId, session_id: sessionId, input_fp: fp, model }).catch(() => {});
    // Lịch sử đo (migration 032): chỉ ghi khi vừa tính MỚI (cache hit không
    // tới đây). Ghi hỏng thì nuốt — truy vết không được làm gãy luồng đo.
    await deps.db.appendSentimentHistory({ ...sentiment, website_id: websiteId, session_id: sessionId, input_fp: fp, model, source }).catch(() => {});
    // Dải cảm xúc lên custom data Crisp cho nút Tâm trạng của mặt native
    // (Ethan duyệt 2026-10-30, xem copilot/mood-band.ts). Chỉ khi vừa tính
    // MỚI, và CHỈ khi caller bật cờ syncBand: các đường của panel iframe
    // team đang dùng (check/generate/analyze) KHÔNG truyền cờ này nên
    // hành vi + độ trễ của chúng không đổi một ly — đường đồng bộ chỉ
    // chạy ở precompute (job nền qua n8n) và các hook/fetch của mặt
    // native. Sync tự nuốt lỗi, tự bỏ qua khi dải không đổi.
    if (deps.crisp && deps.syncBand) {
      await syncMoodBand({ crisp: deps.crisp }, websiteId, sessionId, sentiment.score).catch(() => null);
    }
    return { sentiment, cached: false, reason: null };
  } catch (e) {
    console.error("sentiment failed", e);
    return { sentiment: cached ? strip(cached) : null, cached: Boolean(cached), reason: cached ? null : "ai_unavailable" };
  }
}

/** Action analyze: CS bấm "Phân tích" trong panel Ý định & Tâm trạng. */
export async function runAnalyze(
  req: { website_id: string; session_id: string; force: boolean },
  deps: LoadDeps & { ai: Ai; crisp?: CrispClient | null },
): Promise<AnalyzeResult> {
  const { conv, messages } = await loadConversationFast(deps, req.website_id, req.session_id);
  void conv;
  const { sentiment, cached, reason } = await resolveSentiment(deps, req.website_id, req.session_id, messages, req.force, "analyze");
  return { action: "analyze", sentiment, cached, msg_count: customerMessageCount(messages), reason };
}
