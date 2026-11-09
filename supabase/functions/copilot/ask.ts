import { HttpError } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { Ai } from "../_shared/gemini.ts";
import { ASK_SCHEMA, askPrompt, parseAskAnswer, parseJson, TRANSLATE_SCHEMA, translatePrompt } from "../_shared/prompts.ts";
import { looksEnglish } from "../_shared/translate.ts";
import type { HelpdeskChunk } from "../_shared/types.ts";
import { HELPDESK_K } from "./generate.ts";

export interface AskResult {
  action: "ask";
  found: boolean;
  answer: string | null;
  sources: { title: string; url: string }[];
}

const NOT_FOUND: AskResult = { action: "ask", found: false, answer: null, sources: [] };

/**
 * Sàn ngữ nghĩa cho ứng viên CHỈ có phía vector (không khớp full-text):
 * dưới sàn này mà cũng không khớp chữ nào thì không đủ bằng chứng đưa AI
 * (giữ kỷ luật cũ của ask). Ứng viên có ftsRank thì qua sàn bất kể cosine —
 * khớp chữ có stemming + hạng là bằng chứng độc lập với vector.
 */
const ASK_WEAK_FLOOR = 0.45;
/** Số kết quả hybrid lấy về cho mỗi biến thể câu hỏi trước khi gộp. */
const ASK_HYBRID_K = 8;

/**
 * Bản tiếng Anh của câu hỏi để truy hồi SONG SONG bản gốc: kho tài liệu là
 * tiếng Anh nên câu hỏi tiếng Việt gần như mù cả vector lẫn từ khoá nếu không
 * dịch. Theo đúng
 * mẫu của hệ thống: tin khách cũng được dịch sang content_en để truy hồi.
 * Lỗi dịch → null, truy hồi chạy bằng bản gốc như cũ.
 */
async function englishVariant(deps: { ai: Ai }, question: string): Promise<string | null> {
  if (looksEnglish(question)) return null;
  try {
    const { text } = await deps.ai.generate("translate", translatePrompt([question]), { schema: TRANSLATE_SCHEMA });
    const items = parseJson<{ items?: { i: number; en: string }[] }>(text).items ?? [];
    const en = items.find((it) => it.i === 0)?.en?.trim();
    return en && en.toLowerCase() !== question.toLowerCase() ? en : null;
  } catch (e) {
    console.error("ask translate failed", e);
    return null;
  }
}

/**
 * Gộp kết quả hybrid của các biến thể câu hỏi (bản gốc + bản dịch tiếng
 * Anh): cùng một đoạn về từ hai biến thể thì giữ bản điểm RRF cao hơn, rồi
 * xếp lại theo điểm. Xuất khẩu cho test.
 */
export function mergeHybridChunks(lists: HelpdeskChunk[][]): HelpdeskChunk[] {
  const byKey = new Map<string, HelpdeskChunk>();
  for (const c of lists.flat()) {
    const key = `${c.title}|${c.text.slice(0, 80)}`;
    const prev = byKey.get(key);
    if (!prev || (c.score ?? 0) > (prev.score ?? 0)) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Ứng viên đủ bằng chứng để đưa AI phán quyết (xem ASK_WEAK_FLOOR). */
function qualifies(c: HelpdeskChunk): boolean {
  return c.similarity >= ASK_WEAK_FLOOR || c.ftsRank != null;
}

/**
 * Truy hồi helpdesk cho câu hỏi của CS bằng HYBRID SEARCH (migration 030):
 * RPC gộp hạng vector (pgvector) + full-text
 * (tsvector có stemming) bằng RRF ngay trong DB — không dùng hai tầng
 * vector/ILIKE (ILIKE không stemming, không hạng, chỉ chạy khi vector
 * trượt hẳn). Câu hỏi không phải tiếng Anh thì chạy hybrid cho CẢ bản gốc
 * lẫn bản dịch tiếng Anh rồi gộp theo điểm RRF. AI trả lời vẫn là chốt
 * chặn cuối: bài không trả lời được câu hỏi thì answered=false → not found.
 * Lỗi truy hồi thì coi như không có bài dùng được — giống cách generate degrade.
 */
async function retrieveForQuestion(deps: { db: Db; ai: Ai }, websiteId: string, question: string): Promise<HelpdeskChunk[]> {
  try {
    const en = await englishVariant(deps, question);
    const variants = en ? [en, question] : [question];
    const vecs = await deps.ai.embed(variants, "query");
    const lists = await Promise.all(variants.map((q, i) =>
      deps.db.hybridMatchHelpdesk(websiteId, q, vecs[i], ASK_HYBRID_K).catch((e) => {
        console.error("ask hybrid retrieval failed", e);
        return [] as HelpdeskChunk[];
      })
    ));
    return mergeHybridChunks(lists).filter(qualifies).slice(0, HELPDESK_K);
  } catch (e) {
    console.error("ask retrieval failed", e);
    return [];
  }
}

/**
 * Action ask (Hỏi tài liệu — board 3): trả lời câu hỏi của CS chỉ từ helpdesk.
 * Không có ứng viên nào đủ bằng chứng sau hybrid search → found: false, KHÔNG gọi AI.
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
