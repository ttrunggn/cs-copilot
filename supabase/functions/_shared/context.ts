import { sha256Hex } from "./auth.ts";
import type { MessageRow } from "./types.ts";

function byTime(messages: MessageRow[]): MessageRow[] {
  return [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

function isCustomerFacing(m: MessageRow): boolean {
  return m.type !== "note" && m.type !== "event";
}

/** Hội thoại dạng text cho prompt (tiếng Anh): bỏ tin bot và event, note ghi rõ là nội bộ, tin khách dùng bản dịch nếu có. */
export function humanTranscript(messages: MessageRow[], maxLines = 40): string {
  const lines: string[] = [];
  for (const m of byTime(messages)) {
    if (m.is_bot || m.type === "event") continue;
    const who = m.from === "user" ? "Customer" : `Agent${m.operator_name ? ` (${m.operator_name})` : ""}`;
    const text = m.content_en ?? m.content;
    const body = m.type === "note" ? `[Internal note] ${text}` : text;
    lines.push(`${who}: ${body.slice(0, 1500)}`);
  }
  return lines.slice(-maxLines).join("\n");
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
