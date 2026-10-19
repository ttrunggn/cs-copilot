// Tóm tắt hội thoại đã resolve thành "case tương tự" để Soạn tin tham khảo cách team từng xử lý.
import { DATA_ONLY, neutralize, parseJson } from "./prompts.ts";
import type { MessageRow } from "./types.ts";

/** Tin trả lời cuối cùng của CS người thật (không note, không bot). */
export function lastAgentReply(messages: MessageRow[]): string | null {
  const replies = [...messages]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .filter((m) => m.from === "operator" && m.type === "text" && !m.is_bot);
  return replies.at(-1)?.content ?? null;
}

export const caseSchema = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { i: { type: "INTEGER" }, summary: { type: "STRING" }, resolution: { type: "STRING" }, skip: { type: "BOOLEAN" } },
        required: ["i", "summary", "resolution", "skip"],
      },
    },
  },
  required: ["items"],
};

export function casePrompt(items: { i: number; transcript: string }[]): string {
  return [
    "For each resolved customer support conversation below, write in English:",
    "summary: the customer's problem in one sentence, generic enough to match similar future cases (no names, store URLs or order numbers).",
    "resolution: how the agent solved it, in 1-2 sentences (concrete steps or the answer given).",
    "skip: true when there was no real support problem or no resolution worth reusing (spam, test, customer never replied, only greetings).",
    `Return {"items":[{"i":<index>,"summary":"...","resolution":"...","skip":false}]} with one item per conversation. ${DATA_ONLY}`,
    items.map((it) => `<conversation i="${it.i}">\n${neutralize(it.transcript)}\n</conversation>`).join("\n"),
  ].join("\n\n");
}

/** index → {summary, resolution}; null = bỏ qua (skip hoặc thiếu nội dung). Index trùng/ngoài khoảng bị bỏ. */
export function parseCases(text: string, count: number): Map<number, { summary: string; resolution: string } | null> {
  const out = new Map<number, { summary: string; resolution: string } | null>();
  for (const it of parseJson<{ items?: { i: number; summary?: string; resolution?: string; skip?: boolean }[] }>(text).items ?? []) {
    if (!Number.isInteger(it.i) || it.i < 0 || it.i >= count || out.has(it.i)) continue;
    const summary = (it.summary ?? "").trim();
    const resolution = (it.resolution ?? "").trim();
    out.set(it.i, it.skip || !summary || !resolution ? null : { summary, resolution });
  }
  return out;
}
