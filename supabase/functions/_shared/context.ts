import type { MessageRow } from "./types.ts";

function byTime(messages: MessageRow[]): MessageRow[] {
  return [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

function isCustomerFacing(m: MessageRow): boolean {
  return m.type !== "note" && m.type !== "event";
}

/** Hội thoại dạng text cho prompt: bỏ tin bot và event, note ghi rõ là nội bộ. */
export function humanTranscript(messages: MessageRow[], maxLines = 40): string {
  const lines: string[] = [];
  for (const m of byTime(messages)) {
    if (m.is_bot || m.type === "event") continue;
    const who = m.from === "user" ? "Khách" : `CS${m.operator_name ? ` (${m.operator_name})` : ""}`;
    const body = m.type === "note" ? `[Ghi chú nội bộ] ${m.content}` : m.content;
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
