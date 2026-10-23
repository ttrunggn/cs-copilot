import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";

export interface SurveyResult {
  action: "survey";
  sent: boolean;
  already: boolean;
  sent_at: string | null;
  /** Lý do gửi không thành (khi sent = false) để panel hiện đúng thay vì đoán. */
  error: string | null;
}

/**
 * Gửi CSAT survey vào conversation qua webhook send-survey của workflow
 * survey trên n8n (gate giữ Crisp plugin key — Edge Function không chạm key).
 * Đã gửi rồi thì không gửi lại: trả trạng thái cũ để panel hiện "đã gửi".
 */
export async function runSurvey(
  req: { website_id: string; session_id: string },
  operatorId: string,
  deps: { db: Db; n8n: N8n },
): Promise<SurveyResult> {
  const existing = await deps.db.getCsatSend(req.website_id, req.session_id);
  if (existing) return { action: "survey", sent: true, already: true, sent_at: existing.sent_at, error: null };

  const operator = await deps.db.getOperator(operatorId).catch(() => null);
  const sent = await deps.n8n.sendSurvey(req.website_id, req.session_id, operator?.display_name ?? "");
  if (!sent) {
    return {
      action: "survey", sent: false, already: false, sent_at: null,
      error: "n8n gate không phản hồi, hoặc workflow survey chưa xác nhận đã gửi (kiểm tra workflow Survey_CSAT_OE đã Active và webhook send-survey).",
    };
  }

  const row = await deps.db.recordCsatSend(req.website_id, req.session_id, operatorId);
  return { action: "survey", sent: true, already: false, sent_at: row?.sent_at ?? new Date().toISOString(), error: null };
}
