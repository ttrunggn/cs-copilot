import type { Db } from "../_shared/db.ts";
import { HttpError } from "../_shared/auth.ts";

/**
 * Lưu lựa chọn "Lưu làm mẫu mới" từ thẻ gợi ý tối ưu (Ethan chốt 2026-10-26):
 * CS là người quyết cuối cùng — server chỉ ghi đúng lựa chọn của CHÍNH CS
 * đang đăng nhập (operatorId từ authorize, không nhận id từ body).
 *
 * - kind "review": bản gợi ý trở thành review_template của CS (mọi dòng
 *   profile của CS trong workspace), gợi ý bị xoá, và manual_override gắn
 *   cờ review_template_manual để các lần học lại không ghi đè.
 * - kind "draft": draft không phải template cố định nên không ghi đè gì —
 *   lưu thành mẫu trong profile_style_samples, đầu vào ưu tiên cho vòng
 *   học profile sau này.
 * Cả hai đều là ghi vào dữ liệu của chính hệ thống copilot — không chạm
 * Crisp/Jira (đúng quy tắc ghi cứng).
 */
export interface SaveSuggestionResult {
  action: "save_suggestion";
  ok: true;
  kind: "draft" | "review";
}

export const SUGGESTION_TEXT_MAX = 3000;

type Deps = { db: Db };

export async function runSaveSuggestion(
  req: { website_id: string; suggestion_kind: string; suggestion_text: string },
  operatorId: string,
  deps: Deps,
): Promise<SaveSuggestionResult> {
  const kind = req.suggestion_kind;
  if (kind !== "draft" && kind !== "review") {
    throw new HttpError(400, `suggestion_kind không hợp lệ: ${kind || "(trống)"}`);
  }
  const text = (req.suggestion_text ?? "").trim();
  if (!text) throw new HttpError(400, "Thiếu nội dung mẫu để lưu");
  if (text.length > SUGGESTION_TEXT_MAX) throw new HttpError(400, "Nội dung mẫu quá dài");
  if (!req.website_id) throw new HttpError(400, "Thiếu website_id");
  if (kind === "review") {
    await deps.db.saveReviewTemplate(operatorId, req.website_id, text);
  }
  await deps.db.addStyleSample(operatorId, req.website_id, kind, text);
  return { action: "save_suggestion", ok: true, kind };
}
