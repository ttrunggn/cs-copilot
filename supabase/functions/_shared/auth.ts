import type { Db } from "./db.ts";
import type { Workspace } from "./types.ts";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Token cá nhân → operator; operator phải thuộc workspace đang mở. */
export async function authorize(
  db: Db,
  req: { website_id: string; token: string },
): Promise<{ workspace: Workspace; operatorId: string }> {
  if (!req.token) throw new HttpError(401, "Thiếu token, nhập token trong widget copilot");
  if (!req.website_id) throw new HttpError(400, "Thiếu website_id");
  const operatorId = await db.getOperatorIdByTokenHash(await sha256Hex(req.token));
  if (!operatorId) throw new HttpError(401, "Token không hợp lệ");
  const workspace = await db.getWorkspace(req.website_id);
  if (!workspace) throw new HttpError(404, "Workspace này chưa được cấu hình trong copilot");
  if (!(await db.isOperatorMember(operatorId, req.website_id))) {
    throw new HttpError(403, "CS không thuộc workspace này");
  }
  return { workspace, operatorId };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Widget plugin trong Crisp: Crisp gắn `token` của website vào URL iframe, widget gửi lại kèm operator lấy từ
 * $crisp.acquireData("operator"). Token đúng → request đến từ Crisp app của workspace; operator phải đang active.
 */
export async function authorizeWidget(
  db: Db,
  req: { website_id: string; crisp_token: string; operator_id: string },
  extraHashes: string[] = [],
): Promise<{ workspace: Workspace; operatorId: string }> {
  if (!req.website_id) throw new HttpError(400, "Thiếu website_id");
  if (!req.crisp_token) throw new HttpError(401, "Mở copilot từ widget trong Crisp");
  if (!req.operator_id) throw new HttpError(400, "Không xác định được CS đang đăng nhập Crisp");
  // Hash chính từ DB = token của plugin Copilot CS. extraHashes mặc định
  // rỗng; CHỈ function test truyền thêm hash token của plugin survey để
  // modal mở từ xe test qua được (cổng pathname ở index.ts) — production
  // không truyền nên hành vi không đổi.
  const presented = await sha256Hex(req.crisp_token);
  const candidates = [await db.getWidgetTokenHash(req.website_id), ...extraHashes].filter((h): h is string => Boolean(h));
  if (!candidates.some((h) => safeEqual(h, presented))) {
    throw new HttpError(401, "Widget không hợp lệ cho workspace này");
  }
  const workspace = await db.getWorkspace(req.website_id);
  if (!workspace) throw new HttpError(404, "Workspace này chưa được cấu hình trong copilot");
  if (!(await db.isOperatorMember(req.operator_id, req.website_id))) {
    throw new HttpError(403, "CS không thuộc workspace này");
  }
  return { workspace, operatorId: req.operator_id };
}
