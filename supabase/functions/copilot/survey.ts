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
 * Đây là đường ghi Crisp duy nhất còn lại và là ngoại lệ có chủ đích (survey
 * không staging qua ô soạn được).
 *
 * Chống gửi trùng PHẢI nguyên tử: claim (insert ignoreDuplicates trên PK
 * conversation) TRƯỚC khi gọi n8n. Kiểm-trước/gửi/sau-mới-ghi sẽ khiến hai
 * request đồng thời (double-click, retry, panel + MCP cùng lúc) đều thấy
 * "chưa gửi" và cùng bắn survey cho khách. Chỉ request claim thắng mới
 * được gửi; claim thua → trả trạng thái đã gửi. Gửi thất bại (n8n trả false)
 * thì NHẢ claim để CS bấm lại được — đánh đổi đã biết: nếu n8n thật ra đã gửi
 * mà response lỗi, lần bấm lại vẫn có thể trùng; cửa sổ đó hẹp hơn nhiều so
 * với race đồng thời và không có cách phân biệt hai trường hợp từ response.
 *
 * Claim KHÔNG phải khoá vĩnh viễn theo conversation: team CS tự quyết khi
 * nào xin lại. Claim cũ ngoài cửa sổ RESEND_GUARD_MS được nhả để
 * lần bấm mới claim lại và gửi thật; trong cửa sổ thì vẫn chặn như race.
 */
/** Cửa sổ chống bấm đúp/bắn trùng đồng thời: trong khoảng này, request thứ hai
 * được coi là cùng một lần gửi. Ngoài cửa sổ, CS bấm là gửi lại thật — không
 * khoá nút survey, team tự biết khi nào nên xin. */
const RESEND_GUARD_MS = 30_000;

export async function runSurvey(
  req: { website_id: string; session_id: string; operator_name?: string },
  operatorId: string,
  deps: { db: Db; n8n: N8n },
): Promise<SurveyResult> {
  const existing = await deps.db.getCsatSend(req.website_id, req.session_id);
  if (existing) {
    const ageMs = Date.now() - Date.parse(existing.sent_at);
    if (Number.isFinite(ageMs) && ageMs < RESEND_GUARD_MS) {
      return { action: "survey", sent: true, already: true, sent_at: existing.sent_at, error: null };
    }
    // Đã gửi từ trước và ngoài cửa sổ chống trùng: nhả claim cũ để gửi lại.
    await deps.db.releaseCsatSend(req.website_id, req.session_id).catch(() => {});
  }

  // Tên trong survey phải theo ACCOUNT Crisp đang đăng nhập (widget gửi lên,
  // thắng bản sao trong DB có thể cũ) — cùng chuẩn generate/handoff.
  const operator = await deps.db.getOperator(operatorId).catch(() => null);
  const agentName = (req.operator_name ?? "").trim() || operator?.display_name?.trim() || "";

  const claim = await deps.db.recordCsatSend(req.website_id, req.session_id, operatorId);
  if (!claim) {
    // Claim thua: request khác vừa claim/gửi xong trong lúc mình chuẩn bị.
    const row = await deps.db.getCsatSend(req.website_id, req.session_id).catch(() => null);
    return { action: "survey", sent: true, already: true, sent_at: row?.sent_at ?? new Date().toISOString(), error: null };
  }

  const sent = await deps.n8n.sendSurvey(req.website_id, req.session_id, agentName);
  if (!sent) {
    await deps.db.releaseCsatSend(req.website_id, req.session_id).catch(() => {});
    return {
      action: "survey", sent: false, already: false, sent_at: null,
      error: "n8n gate không phản hồi, hoặc workflow survey chưa xác nhận đã gửi (kiểm tra workflow Survey_CSAT_OE đã Active và webhook send-survey).",
    };
  }

  return { action: "survey", sent: true, already: false, sent_at: claim.sent_at ?? new Date().toISOString(), error: null };
}
