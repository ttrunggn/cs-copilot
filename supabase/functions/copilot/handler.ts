import { authorize, authorizeWidget, HttpError } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import { type Ai, AiBadOutput, AiUnavailable } from "../_shared/gemini.ts";
import type { N8n } from "../_shared/n8n.ts";
import { runCheck } from "./check.ts";
import { runGenerate } from "./generate.ts";
import { runHandoff } from "./handoff.ts";

export type { CheckResult } from "./check.ts";
export type { GenerateResult } from "./generate.ts";
export type { HandoffResult } from "./handoff.ts";

const ACTIONS = ["check", "handoff", "generate"] as const;
type Action = typeof ACTIONS[number];
// session_id/website_id đi vào URL Crisp ở phía n8n nên phải đúng định dạng Crisp.
const SESSION_ID = /^session_[\w-]+$/;
const WEBSITE_ID = /^[\w-]+$/;

export interface CopilotRequest {
  website_id: string;
  session_id: string;
  action: Action;
  force: boolean;
  crisp_token: string;
  operator_id: string;
}

export interface Deps {
  db: Db;
  n8n: N8n;
  ai: Ai;
  /** Việc nền sau response (refresh cho đường đọc nhanh); vắng mặt thì chạy đồng bộ. */
  background?: (task: Promise<unknown>) => void;
  now?: () => number;
}

function parseRequest(body: unknown): CopilotRequest {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Body phải là JSON object");
  const b = body as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  const action = str("action") as Action;
  if (!ACTIONS.includes(action)) throw new HttpError(400, `action không hợp lệ: ${str("action")}`);
  if (!str("session_id")) throw new HttpError(400, "Thiếu session_id");
  if (!SESSION_ID.test(str("session_id"))) throw new HttpError(400, "session_id không hợp lệ");
  if (str("website_id") && !WEBSITE_ID.test(str("website_id"))) throw new HttpError(400, "website_id không hợp lệ");
  return {
    website_id: str("website_id"),
    session_id: str("session_id"),
    action,
    force: b.force === true || b.force === "1",
    crisp_token: str("crisp_token"),
    operator_id: str("operator_id"),
  };
}

export async function handle(body: unknown, token: string, deps: Deps): Promise<{ status: number; body: unknown }> {
  try {
    const req = parseRequest(body);
    // Token cá nhân (curl/tooling) hoặc widget trong Crisp (token website + operator từ SDK).
    const { workspace: ws, operatorId } = token
      ? await authorize(deps.db, { website_id: req.website_id, token })
      : await authorizeWidget(deps.db, req);
    switch (req.action) {
      case "check":
        return { status: 200, body: await runCheck(req, ws, operatorId, deps) };
      case "handoff":
        return { status: 200, body: await runHandoff(req, ws, operatorId, deps) };
      case "generate":
        return { status: 200, body: await runGenerate(req, ws, operatorId, deps) };
    }
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
    if (e instanceof AiBadOutput) {
      console.error("copilot ai bad output", e.message);
      return { status: 503, body: { error: "AI trả kết quả không dùng được, bấm lại thử", code: "AI_BAD_OUTPUT" } };
    }
    if (e instanceof AiUnavailable) {
      console.error("copilot ai unavailable", e.message);
      return { status: 503, body: { error: "AI đang hết quota hoặc lỗi, thử lại sau", code: "AI_UNAVAILABLE" } };
    }
    console.error("copilot error", e);
    return { status: 500, body: { error: "Lỗi hệ thống, thử lại sau" } };
  }
}
