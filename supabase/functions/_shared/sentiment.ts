// Phân tích tâm trạng khách — thay bản keyword trong workflow survey cũ.
//
// Bài học từ bản cũ (n8n analyze-mood): keyword bắt chuỗi con không hiểu phủ
// định ("not resolved" vẫn +điểm resolved), nhãn suy từ điểm nên "urgent"
// không bao giờ hiện, công thức trộn điểm là số tay không hiệu chuẩn.
// Bản này: AI là nguồn chính với rubric + ví dụ mẫu; mood và urgency là HAI
// trục độc lập; có confidence để nơi dùng tự quyết có tin hay không.
import { DATA_ONLY, neutralize, parseJson } from "./prompts.ts";

export type Mood = "frustrated" | "confused" | "neutral" | "satisfied" | "happy";
export type Urgency = "low" | "medium" | "high";

export interface SentimentIssue {
  summary: string; // câu phát biểu VẤN ĐỀ bằng tiếng Việt (AI tổng hợp, không phải trích nguyên văn)
  evidence: string; // trích ngắn nguyên văn lời khách làm bằng chứng; rỗng nếu không có câu nào đắt
}

export interface Sentiment {
  score: number; // 0-100, trạng thái hiện tại của khách (cuối hội thoại)
  mood: Mood;
  urgency: Urgency;
  confidence: number; // 0-1
  summary: string; // tiếng Việt, tối đa ~15 từ
  signals: string[];
  // Vấn đề của khách, tách riêng khỏi signals (Lỗi 4, Ethan 2026-10-26:
  // panel từng map signals — trích nguyên văn — thành thẻ issue, và cả tin
  // cập nhật tiến độ cũng thành "issue"). Issue phải là câu tóm tắt vấn đề;
  // tin không nêu vấn đề thì không sinh issue.
  issues: SentimentIssue[];
}

const MOODS: Mood[] = ["frustrated", "confused", "neutral", "satisfied", "happy"];
const URGENCIES: Urgency[] = ["low", "medium", "high"];

export const SENTIMENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "INTEGER" },
    mood: { type: "STRING", enum: MOODS },
    urgency: { type: "STRING", enum: URGENCIES },
    confidence: { type: "NUMBER" },
    summary: { type: "STRING" },
    signals: { type: "ARRAY", items: { type: "STRING" } },
    issues: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          summary: { type: "STRING" },
          evidence: { type: "STRING" },
        },
        required: ["summary"],
      },
    },
  },
  required: ["score", "mood", "urgency", "confidence", "summary", "signals"],
};

export function sentimentPrompt(transcript: string): string {
  return [
    "Analyze the CUSTOMER's current emotional state at the END of this support conversation for a Shopify app (store translation). " +
      "Agent and Bot lines are context only — never score the agent's mood. The customer may write in any language; judge meaning, not keywords.",
    [
      "Score anchors (0-100, the customer's state right now, latest messages weigh most):",
      "- 5-25: angry or threatening — refund/chargeback demands, insults, churn threats still standing at the end.",
      "- 26-42: frustrated — problem unresolved, repeating themselves, waiting too long, disappointment unaddressed.",
      "- 43-57: neutral or unclear — purely factual exchange, or too little signal.",
      "- 58-74: satisfied — issue resolved or progressing well, polite closing.",
      "- 75-95: happy — explicit thanks, praise, or delight at the end.",
      "Negation flips meaning: \"still not resolved\" is frustrated, not resolved. Sarcasm counts by intent, not literal words.",
      "A conversation that started angry but ended with thanks is satisfied/happy — score where it ENDED.",
    ].join("\n"),
    [
      "urgency is a SEPARATE axis from mood (a calm customer can be urgent):",
      "- high: business blocked (store broken before a launch/sale), explicit deadline, money being lost now.",
      "- medium: work is slowed, waiting noticeably, needs an answer to proceed.",
      "- low: general question, no time pressure.",
    ].join("\n"),
    "confidence: 0-1 — low when there are few customer messages, mixed signals, or heavy sarcasm/ambiguity.",
    "summary: in Vietnamese, at most 15 words, the customer's final state and why. signals: up to 3 short evidence phrases (quote or paraphrase the decisive customer words).",
    [
      "issues: the customer's distinct PROBLEMS, at most 3, each as ONE short Vietnamese problem statement YOU synthesize from the whole conversation (never a raw quote as the statement).",
      "- Only real problems the customer needs solved: something broken, blocked, charged wrongly, not understood, or waited on too long.",
      "- A customer message that merely reports progress or a status (e.g. \"I have accepted you\", \"done\", \"ok thanks\") is NOT an issue — never turn it into one.",
      "- Merge messages about the same underlying problem into a single issue. If the customer states no concrete problem, return an empty array.",
      "- evidence: one short verbatim customer quote (at most ~10 words) backing the issue, or an empty string when no single quote is decisive.",
      "Example: customer says \"I deleted it in April but it is still charging\" → issue summary \"Khách bị trừ tiền sau khi đã gỡ app\", evidence \"it is still charging\".",
    ].join("\n"),
    "Examples: customer ends \"still not working after 3 days, my store launch is tomorrow\" → score ~25, mood frustrated, urgency high. " +
      "Customer ends \"ya funciona, muchas gracias!\" → score ~80, mood happy, urgency low. " +
      "Customer asks \"how do I translate the checkout page?\" with no emotion → score ~50, mood neutral, urgency low.",
    `Return JSON {"score":<int>,"mood":"<one of ${MOODS.join("|")}>","urgency":"<one of ${URGENCIES.join("|")}>","confidence":<0-1>,"summary":"<Vietnamese>","signals":["..."],"issues":[{"summary":"<Vietnamese problem statement>","evidence":"<short quote or empty>"}]}. ${DATA_ONLY}`,
    `<conversation>\n${neutralize(transcript)}\n</conversation>`,
  ].join("\n\n");
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Chuẩn hoá output AI: thiếu/sai trường thì suy từ điểm như bảng neo, không ném lỗi. */
export function parseSentiment(text: string): Sentiment {
  let r: Partial<Sentiment> = {};
  try {
    r = parseJson<Partial<Sentiment>>(text);
  } catch {
    r = {}; // AI trả rác → dùng bảng neo với điểm trung tính thay vì ném lỗi
  }
  const score = clamp(Math.round(typeof r.score === "number" ? r.score : 50), 0, 100);
  const mood: Mood = MOODS.includes(r.mood as Mood)
    ? (r.mood as Mood)
    : score <= 42
    ? "frustrated"
    : score <= 57
    ? "neutral"
    : score <= 74
    ? "satisfied"
    : "happy";
  return {
    score,
    mood,
    urgency: URGENCIES.includes(r.urgency as Urgency) ? (r.urgency as Urgency) : "low",
    confidence: clamp(typeof r.confidence === "number" ? r.confidence : 0.5, 0, 1),
    summary: typeof r.summary === "string" ? r.summary.trim().slice(0, 200) : "",
    signals: (Array.isArray(r.signals) ? r.signals : []).filter((s) => typeof s === "string").slice(0, 3),
    issues: parseIssues(r.issues),
  };
}

/** Chuẩn hoá issues của AI: chỉ giữ mục có summary, cắt độ dài, khử trùng, tối đa 3. */
export function parseIssues(raw: unknown): SentimentIssue[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SentimentIssue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const summary = typeof (item as SentimentIssue).summary === "string" ? (item as SentimentIssue).summary.trim().slice(0, 140) : "";
    if (!summary || seen.has(summary.toLowerCase())) continue;
    seen.add(summary.toLowerCase());
    const evidence = typeof (item as SentimentIssue).evidence === "string" ? (item as SentimentIssue).evidence.trim().slice(0, 120) : "";
    out.push({ summary, evidence });
    if (out.length >= 3) break;
  }
  return out;
}

export const MOOD_EMOJI: Record<Mood, string> = {
  frustrated: "😤",
  confused: "😕",
  neutral: "😐",
  satisfied: "😊",
  happy: "😄",
};

export const MOOD_LABEL: Record<Mood, string> = {
  frustrated: "Đang bực / chưa hài lòng",
  confused: "Đang bối rối",
  neutral: "Trung tính",
  satisfied: "Hài lòng",
  happy: "Rất vui",
};

/**
 * Lớp 2 của draft: điều chỉnh CÁCH chuyển tải theo mood của khách.
 * Chỉ chỉnh nhịp/độ ấm/thứ tự ưu tiên — không đổi sự kiện, không đụng xưng hô,
 * chữ ký hay giọng gốc (Layer 1) của CS.
 */
export function sentimentGuidance(s: Sentiment): string {
  const lines: string[] = [];
  if (s.mood === "frustrated" || s.urgency === "high") {
    lines.push(
      "The customer is frustrated and/or this is urgent. Delivery adjustments (override the style defaults where they conflict):",
      "- Open by acknowledging their specific problem in one plain line — no cheerful opener, no emoji anywhere, no thanks-for-reaching-out.",
      "- Be short and concrete: what happens next and the exact info/action needed. If a timeframe is not stated in the conversation or help center, do not invent one — use a [[CS: …]] check for it.",
      "- Never ask for a review, rating, upgrade or anything promotional in this state.",
    );
  } else if (s.mood === "confused") {
    lines.push(
      "The customer seems confused. Delivery adjustments:",
      "- Explain step by step, numbered, one action per step; define any product term in plain words the first time it appears.",
      "- End by asking them to confirm the step they are stuck on, rather than a generic \"let me know\".",
    );
  } else if (s.mood === "satisfied" || s.mood === "happy") {
    lines.push(
      "The customer is in a good mood. Delivery adjustments:",
      "- A warmer, lighter tone is welcome; keep the agent's own signature and pronoun choices unchanged.",
      "- One brief friendly closing line is fine; do not turn the reply into marketing.",
    );
  }
  return lines.join("\n");
}
