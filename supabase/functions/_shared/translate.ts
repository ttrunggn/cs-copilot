import { parseJson, TRANSLATE_SCHEMA, translatePrompt } from "./prompts.ts";
import type { Ai } from "./gemini.ts";
import type { MessageRow } from "./types.ts";

const STOPWORDS = new Set(
  "the a an i you we it is are was to of in on for and or but not my your this that what why how can do does have has please hi hello thanks thank app store"
    .split(" "),
);
const MAX_BATCH = 20;
const MAX_CHARS = 1500;

/** Đoán nhanh tin có phải tiếng Anh không (không gọi AI): ít ký tự ngoài ASCII và đủ stopword tiếng Anh. */
export function looksEnglish(text: string): boolean {
  const chars = [...text];
  if (!chars.length) return true;
  const nonAscii = chars.filter((ch) => ch.charCodeAt(0) > 127).length;
  if (nonAscii / chars.length > 0.1) return false;
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length <= 3) return true;
  return words.filter((w) => STOPWORDS.has(w)).length / words.length >= 0.2;
}

function needsCheck(m: MessageRow): boolean {
  return m.from === "user" && m.type === "text" && !m.is_bot && m.content_en === null;
}

/** Điền content_en cho tin khách: tiếng Anh thì chép nguyên, còn lại dịch một lần. AI lỗi thì giữ bản gốc. */
export async function ensureEnglish(
  messages: MessageRow[],
  ai: Ai,
  save: (rows: { id: number; content_en: string }[]) => Promise<void>,
): Promise<MessageRow[]> {
  const found = new Map<number, string>();
  const foreign: MessageRow[] = [];
  for (const m of messages) {
    if (!needsCheck(m)) continue;
    if (looksEnglish(m.content)) found.set(m.id, m.content);
    else foreign.push(m);
  }
  const batch = foreign.slice(-MAX_BATCH);
  if (batch.length) {
    try {
      const { text } = await ai.generate("translate", translatePrompt(batch.map((m) => m.content.slice(0, MAX_CHARS))), {
        schema: TRANSLATE_SCHEMA,
      });
      const seen = new Set<number>();
      for (const it of parseJson<{ items: { i: number; en: string }[] }>(text).items ?? []) {
        const m = batch[it.i];
        // Index trùng hoặc ngoài khoảng là dấu hiệu output bị lái: chỉ nhận bản đầu tiên của mỗi tin.
        if (!m || seen.has(it.i) || typeof it.en !== "string" || !it.en.trim()) continue;
        seen.add(it.i);
        found.set(m.id, it.en.trim());
      }
    } catch (e) {
      console.error("translate failed, using original text", e);
    }
  }
  if (found.size) {
    try {
      await save([...found].map(([id, content_en]) => ({ id, content_en })));
    } catch (e) {
      console.error("save translations failed", e);
    }
  }
  return messages.map((m) => (found.has(m.id) ? { ...m, content_en: found.get(m.id)! } : m));
}
