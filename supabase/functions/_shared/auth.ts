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
