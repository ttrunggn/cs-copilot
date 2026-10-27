import { HttpError } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { Ai } from "../_shared/gemini.ts";
import { ASK_SCHEMA, askPrompt, parseAskAnswer, parseJson, TRANSLATE_SCHEMA, translatePrompt } from "../_shared/prompts.ts";
import { looksEnglish } from "../_shared/translate.ts";
import type { HelpdeskChunk } from "../_shared/types.ts";
import { HELPDESK_K, HELPDESK_MIN_SIMILARITY } from "./generate.ts";

export interface AskResult {
  action: "ask";
  found: boolean;
  answer: string | null;
  sources: { title: string; url: string }[];
}

const NOT_FOUND: AskResult = { action: "ask", found: false, answer: null, sources: [] };

/** Ngưỡng sàn cho ứng viên vector YẾU ở tầng dự phòng của ask (generate không dùng). */
const ASK_WEAK_FLOOR = 0.45;
/** Số ứng viên vector lấy về để xét cả hai tầng. */
const ASK_CANDIDATES = 8;

/** Từ dừng Việt/Anh phổ biến — bỏ khỏi token từ khoá để truy vấn đỡ nhiễu. */
const STOPWORDS = new Set([
  "của", "là", "bị", "gì", "này", "đó", "cho", "không", "có", "được", "khách", "case",
  "và", "thì", "mà", "trong", "để", "như", "thế", "nào", "bao", "nhiêu",
  "the", "and", "for", "how", "what", "when", "why", "can", "does", "with", "this", "that",
]);

/** Tách câu hỏi thành token từ khoá (giữ dấu tiếng Việt), bỏ từ dừng và token quá ngắn. */
export function questionTokens(question: string): string[] {
  const parts = question.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  return [...new Set(parts.filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
}

/**
 * Bản tiếng Anh của câu hỏi để truy hồi SONG SONG bản gốc: kho tài liệu là
 * tiếng Anh nên câu hỏi tiếng Việt gần như mù cả vector lẫn từ khoá nếu không
 * dịch (ca Ethan thử live 2026-10-27: "khách muốn chặn bản dịch"). Theo đúng
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

function dedupeChunks(chunks: HelpdeskChunk[]): HelpdeskChunk[] {
  const seen = new Set<string>();
  const out: HelpdeskChunk[] = [];
  for (const c of chunks) {
    const key = `${c.title}|${c.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Truy hồi helpdesk cho câu hỏi của CS — HAI tầng (Ethan chốt 2026-10-27:
 * team gõ từ khoá/câu hỏi đời thường vẫn phải ra đáp án, không bắt hỏi
 * nguyên văn trúng khớp):
 * 1) Vector qua ngưỡng chặt của generate → dùng ngay (hành vi cũ).
 * 2) Không qua ngưỡng: nới sàn vector + tìm theo TỪ KHOÁ trong nội dung đoạn,
 *    gộp hai nguồn làm ứng viên. AI trả lời vẫn là chốt chặn cuối: bài không
 *    trả lời được câu hỏi thì parseAskAnswer trả answered=false → not found,
 *    không hiện đáp án thiếu căn cứ.
 * Câu hỏi không phải tiếng Anh thì truy hồi bằng CẢ bản gốc lẫn bản dịch
 * tiếng Anh (token từ khoá cũng lấy từ cả hai).
 * Lỗi truy hồi thì coi như không có bài dùng được — giống cách generate degrade.
 */
async function retrieveForQuestion(deps: { db: Db; ai: Ai }, websiteId: string, question: string): Promise<HelpdeskChunk[]> {
  try {
    const en = await englishVariant(deps, question);
    const queries = en ? [en, question] : [question];
    const vecs = await deps.ai.embed(queries, "query");
    const perQuery = await Promise.all(queries.map((_, i) => deps.db.matchHelpdesk(websiteId, vecs[i], ASK_CANDIDATES)));
    const all = perQuery.flat();
    const strong = all.filter((c) => c.similarity >= HELPDESK_MIN_SIMILARITY);
    if (strong.length) return dedupeChunks(strong).slice(0, HELPDESK_K);
    const weak = all.filter((c) => c.similarity >= ASK_WEAK_FLOOR);
    let keyword: HelpdeskChunk[] = [];
    try {
      keyword = await deps.db.searchHelpdeskText(websiteId, queries.flatMap((q) => questionTokens(q)), HELPDESK_K);
    } catch (e) {
      console.error("ask keyword retrieval failed", e);
    }
    return dedupeChunks([...weak, ...keyword]).slice(0, HELPDESK_K);
  } catch (e) {
    console.error("ask retrieval failed", e);
    return [];
  }
}

/**
 * Action ask (Hỏi tài liệu — board 3): trả lời câu hỏi của CS chỉ từ helpdesk.
 * Không có ứng viên nào sau cả hai tầng truy hồi → found: false, KHÔNG gọi AI.
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
