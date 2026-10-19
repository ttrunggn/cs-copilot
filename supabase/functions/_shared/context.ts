import { sha256Hex } from "./auth.ts";
import type { MessageRow } from "./types.ts";

// Tin khách dài nhiều vấn đề phải tới AI đủ ý; tổng transcript vẫn có trần để prompt không phình.
const MAX_MESSAGE_CHARS = 6000;
const MAX_TRANSCRIPT_CHARS = 24000;

function byTime(messages: MessageRow[]): MessageRow[] {
  return [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

function isCustomerFacing(m: MessageRow): boolean {
  return m.type !== "note" && m.type !== "event";
}

/**
 * Hội thoại dạng text cho prompt (tiếng Anh). Mặc định bỏ bot để học giọng CS;
 * draft/handoff có thể giữ bot reply để biết khách đã được thông báo điều gì.
 */
export function humanTranscript(messages: MessageRow[], maxLines = 40, includeBotReplies = false): string {
  const lines: string[] = [];
  for (const m of byTime(messages)) {
    if (m.type === "event" || (m.is_bot && (!includeBotReplies || m.type !== "text"))) continue;
    const who = m.from === "user"
      ? "Customer"
      : m.is_bot
      ? `Bot${m.operator_name ? ` (${m.operator_name})` : ""}`
      : `Agent${m.operator_name ? ` (${m.operator_name})` : ""}`;
    const text = m.content_en ?? m.content;
    const body = m.type === "note" ? `[Internal note] ${text}` : text;
    lines.push(`${who}: ${body.slice(0, MAX_MESSAGE_CHARS)}`);
  }
  // Giữ dòng mới nhất trước; vượt tổng trần thì bỏ dòng cũ nhất.
  const kept: string[] = [];
  let total = 0;
  for (const line of lines.slice(-maxLines).reverse()) {
    if (kept.length && total + line.length + 1 > MAX_TRANSCRIPT_CHARS) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return kept.join("\n");
}

/** Các tin khách gửi liên tiếp sau lần cuối một CS người thật trả lời. Bot và note không tính là trả lời. */
export function unansweredCustomerMessages(messages: MessageRow[]): string[] {
  const real = byTime(messages).filter((m) => !m.is_bot && isCustomerFacing(m));
  const out: string[] = [];
  for (let i = real.length - 1; i >= 0 && real[i].from === "user"; i--) out.unshift(real[i].content);
  return out;
}

/** Câu hỏi của khách để tìm helpdesk/case: các tin chưa trả lời (bản tiếng Anh), không có thì tin khách cuối. */
export function latestCustomerQuery(messages: MessageRow[]): string {
  const real = byTime(messages).filter((m) => !m.is_bot && isCustomerFacing(m));
  const pending: string[] = [];
  for (let i = real.length - 1; i >= 0 && real[i].from === "user"; i--) pending.unshift(real[i].content_en ?? real[i].content);
  if (pending.length) return pending.join("\n").slice(0, 2000);
  const last = real.filter((m) => m.from === "user").at(-1);
  return (last ? last.content_en ?? last.content : "").slice(0, 2000);
}

/** Dấu vân tay input cho cache outputs: đổi khi có tin mới, khác loại hoặc khác CS. */
export function inputFingerprint(kind: "draft" | "handoff", operatorId: string, messages: MessageRow[]): Promise<string> {
  const body = JSON.stringify(byTime(messages).map((m) => [m.created_at, m.content]));
  return sha256Hex(`${kind}|${operatorId}|${body}`);
}
