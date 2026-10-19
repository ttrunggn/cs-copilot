// Logic thuần cho việc học giọng văn từng CS và phân loại topic theo lô (script scripts/learn-profiles.ts dùng).
import { DATA_ONLY, neutralize, parseJson, topicLine } from "./prompts.ts";
import type { Profile, Topic } from "./types.ts";

export interface OpMessage {
  operator_id: string;
  session_id: string;
  content: string;
  created_at: string;
}

export const SKIP_TOPICS = ["system_email"];
const MIN_SAMPLE_CHARS = 30;
const MAX_SAMPLE_CHARS = 700;
const MAX_PER_SESSION = 3;
// Ảnh chụp/file đính kèm là của riêng khách đó, không dùng làm tin mẫu cho khách khác.
const CUSTOMER_SPECIFIC = /!\[[^\]]*\]\(|storage\.crisp\.chat/i;
const MAX_PROFILE_SAMPLES = 8;
const SNIPPET_MESSAGES = 3;
const SNIPPET_CHARS = 300;

const distinctSessions = (msgs: OpMessage[]) => new Set(msgs.map((m) => m.session_id)).size;

/**
 * Tin của từng CS → { "_all": [...], <topic>: [...] }. Bỏ hẳn chat thuộc SKIP_TOPICS (email hệ thống).
 * Profile riêng theo topic chỉ khi CS có ≥ minConvs hội thoại ở topic đó; "_all" luôn có.
 */
export function groupForLearning(
  msgs: OpMessage[],
  topicOf: Map<string, string | null>,
  minConvs: number,
): Map<string, Map<string, OpMessage[]>> {
  const byOp = new Map<string, OpMessage[]>();
  for (const m of msgs) {
    if (SKIP_TOPICS.includes(topicOf.get(m.session_id) ?? "")) continue;
    if (!byOp.has(m.operator_id)) byOp.set(m.operator_id, []);
    byOp.get(m.operator_id)!.push(m);
  }
  const out = new Map<string, Map<string, OpMessage[]>>();
  for (const [opId, list] of byOp) {
    const groups = new Map<string, OpMessage[]>([["_all", list]]);
    const byTopic = new Map<string, OpMessage[]>();
    for (const m of list) {
      const t = topicOf.get(m.session_id);
      if (!t) continue;
      if (!byTopic.has(t)) byTopic.set(t, []);
      byTopic.get(t)!.push(m);
    }
    for (const [t, tm] of byTopic) if (distinctSessions(tm) >= minConvs) groups.set(t, tm);
    out.set(opId, groups);
  }
  return out;
}

/** Tin mẫu để học: mới nhất trước, bỏ tin quá ngắn/dài, bỏ trùng, tối đa 3 tin mỗi hội thoại. */
export function pickSamples(msgs: OpMessage[], max = 40): string[] {
  const seen = new Set<string>();
  const perSession = new Map<string, number>();
  const out: string[] = [];
  for (const m of [...msgs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    const text = m.content.trim();
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (text.length < MIN_SAMPLE_CHARS || text.length > MAX_SAMPLE_CHARS || seen.has(key) || CUSTOMER_SPECIFIC.test(text)) continue;
    if ((perSession.get(m.session_id) ?? 0) >= MAX_PER_SESSION) continue;
    seen.add(key);
    perSession.set(m.session_id, (perSession.get(m.session_id) ?? 0) + 1);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export const LEARN_SCHEMA = {
  type: "OBJECT",
  properties: {
    tone: { type: "STRING" },
    pronoun_self: { type: "STRING" },
    pronoun_customer: { type: "STRING" },
    use_emoji: { type: "BOOLEAN" },
    signature: { type: "STRING" },
    style_notes: { type: "STRING" },
    sample_indices: { type: "ARRAY", items: { type: "INTEGER" } },
  },
  required: ["tone", "pronoun_self", "pronoun_customer", "use_emoji", "style_notes", "sample_indices"],
};

export function learnPrompt(agentName: string, samples: string[], topicLabel: string | null): string {
  return [
    `Below are real messages the support agent "${agentName}" sent to customers${topicLabel ? ` about: ${topicLabel}` : ""}.`,
    "Describe how this agent writes so another writer can imitate them. Write every field in English.",
    "tone: 3-6 adjectives. pronoun_self / pronoun_customer: how they refer to themselves and the customer. " +
    "use_emoji: whether they use emoji. signature: their usual sign-off line, or empty if none. " +
    "style_notes: 2-4 short sentences on length, structure, greetings, how they explain steps and close the message.",
    `sample_indices: up to ${MAX_PROFILE_SAMPLES} indices of the most typical, reusable messages (varied, no customer-specific details).`,
    DATA_ONLY,
    `<samples>\n${samples.map((s, i) => `[${i}] ${neutralize(s)}`).join("\n")}\n</samples>`,
  ].join("\n\n");
}

export function parseLearned(text: string, samples: string[]): Omit<Profile, never> {
  const r = parseJson<Record<string, unknown>>(text);
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
  if (!str("tone")) throw new Error("learned profile thiếu tone");
  const idx = Array.isArray(r.sample_indices) ? r.sample_indices : [];
  const picked: string[] = [];
  for (const i of idx) {
    const s = typeof i === "number" ? samples[i] : undefined;
    if (s && !picked.includes(s)) picked.push(s);
    if (picked.length >= MAX_PROFILE_SAMPLES) break;
  }
  return {
    tone: str("tone"),
    pronoun_self: str("pronoun_self") || "I",
    pronoun_customer: str("pronoun_customer") || "you",
    use_emoji: r.use_emoji === true,
    signature: str("signature") || null,
    sample_messages: picked,
    style_notes: str("style_notes") || null,
  };
}

/** Vài tin đầu của khách mỗi hội thoại (theo thời gian), đủ để phân loại mà không tốn token. */
export function customerSnippets(rows: { session_id: string; content: string; created_at: string }[]): Map<string, string> {
  const by = new Map<string, { content: string; created_at: string }[]>();
  for (const r of rows) {
    if (!by.has(r.session_id)) by.set(r.session_id, []);
    by.get(r.session_id)!.push(r);
  }
  const out = new Map<string, string>();
  for (const [sid, list] of by) {
    const first = list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).slice(0, SNIPPET_MESSAGES);
    out.set(sid, first.map((m) => m.content.trim().slice(0, SNIPPET_CHARS)).join("\n"));
  }
  return out;
}

export function classifyBatchSchema(topics: Topic[]): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { i: { type: "INTEGER" }, topic: { type: "STRING", enum: topics.map((t) => t.key) } },
          required: ["i", "topic"],
        },
      },
    },
    required: ["items"],
  };
}

export function classifyBatchPrompt(items: { i: number; text: string }[], topics: Topic[]): string {
  return [
    "Classify each customer support conversation (customer's first messages) into exactly one topic key.",
    topics.map(topicLine).join("\n"),
    `Return {"items":[{"i":<index>,"topic":"<key>"}]} with one item per conversation. ${DATA_ONLY}`,
    items.map((it) => `<conversation i="${it.i}">\n${neutralize(it.text)}\n</conversation>`).join("\n"),
  ].join("\n\n");
}

/** Chỉ nhận cặp index hợp lệ, topic có trong danh sách, mỗi index một lần. */
export function parseClassifyBatch(text: string, count: number, topics: Topic[]): Map<number, string> {
  const keys = new Set(topics.map((t) => t.key));
  const out = new Map<number, string>();
  for (const it of parseJson<{ items?: { i: number; topic: string }[] }>(text).items ?? []) {
    if (Number.isInteger(it.i) && it.i >= 0 && it.i < count && keys.has(it.topic) && !out.has(it.i)) out.set(it.i, it.topic);
  }
  return out;
}
