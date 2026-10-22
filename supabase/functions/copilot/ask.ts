import { HttpError } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { Ai } from "../_shared/gemini.ts";
import { ASK_SCHEMA, askPrompt, parseAskAnswer } from "../_shared/prompts.ts";
import type { HelpdeskChunk } from "../_shared/types.ts";
import { HELPDESK_K, HELPDESK_MIN_SIMILARITY } from "./generate.ts";

export interface AskResult {
  action: "ask";
  found: boolean;
  answer: string | null;
  sources: { title: string; url: string }[];
}

const NOT_FOUND: AskResult = { action: "ask", found: false, answer: null, sources: [] };

/**
 * Truy hồi helpdesk cho câu hỏi của CS: cùng embedding + match + cùng ngưỡng
 * similarity với generate (bài dưới ngưỡng coi như không liên quan). Lỗi truy
 * hồi thì coi như không có bài dùng được — giống cách generate degrade.
 */
async function retrieveForQuestion(deps: { db: Db; ai: Ai }, websiteId: string, question: string): Promise<HelpdeskChunk[]> {
  try {
    const [vec] = await deps.ai.embed([question], "query");
    const found = await deps.db.matchHelpdesk(websiteId, vec, HELPDESK_K);
    return found.filter((c) => c.similarity >= HELPDESK_MIN_SIMILARITY);
  } catch (e) {
    console.error("ask retrieval failed", e);
    return [];
  }
}

/**
 * Action ask (Hỏi tài liệu — board 3): trả lời câu hỏi của CS chỉ từ helpdesk.
 * Không bài nào qua ngưỡng → found: false và KHÔNG gọi AI sinh đáp án.
 * AI bảo bài không trả lời được / output hỏng → cũng found: false, không bao
 * giờ hiện đáp án thiếu căn cứ. Không cache (v1) và không dùng lịch sử chat:
 * đây là hỏi đáp tài liệu độc lập. Lỗi AI (hết quota) thì ném lên handler → 503.
 */
export async function runAsk(
  req: { website_id: string; question: string },
  deps: { db: Db; ai: Ai },
): Promise<AskResult> {
  const question = (req.question ?? "").trim();
  if (!question) throw new HttpError(400, "Thiếu câu hỏi");

  const chunks = await retrieveForQuestion(deps, req.website_id, question);
  if (!chunks.length) return NOT_FOUND;

  const { text } = await deps.ai.generate("ask", askPrompt(question, chunks), { schema: ASK_SCHEMA });
  const parsed = parseAskAnswer(text);
  if (!parsed.answered) return NOT_FOUND;
  return {
    action: "ask",
    found: true,
    answer: parsed.answer,
    sources: chunks.map((c) => ({ title: c.title, url: c.url })),
  };
}
