import { authorize, HttpError } from "../_shared/auth.ts";
import { unansweredCustomerMessages } from "../_shared/context.ts";
import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";
import { type ProfileSource, resolveProfile } from "../_shared/profile.ts";

const ACTIONS = ["check", "handoff", "generate"] as const;
type Action = typeof ACTIONS[number];
const MESSAGE_LIMIT = 60;
// session_id/website_id đi vào URL Crisp ở phía n8n nên phải đúng định dạng Crisp.
const SESSION_ID = /^session_[\w-]+$/;
const WEBSITE_ID = /^[\w-]+$/;

export interface CopilotRequest {
  website_id: string;
  session_id: string;
  action: Action;
  force: boolean;
}

export interface CheckResult {
  action: "check";
  stale: boolean;
  workspace: string;
  topic: string | null;
  topic_label: string | null;
  profile_source: ProfileSource;
  profile_name: string;
  needs_reply: boolean;
  unanswered: string[];
  last_customer_at: string | null;
  last_human_operator_at: string | null;
  jira: unknown[];
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
  };
}

export async function handle(
  body: unknown,
  token: string,
  deps: { db: Db; n8n: N8n },
): Promise<{ status: number; body: unknown }> {
  try {
    const req = parseRequest(body);
    const { workspace: ws, operatorId } = await authorize(deps.db, { website_id: req.website_id, token });
    if (req.action !== "check") throw new HttpError(501, `Chức năng ${req.action} chưa có`);

    const { stale } = await deps.n8n.refreshConversation(req.website_id, req.session_id);
    const conv = await deps.db.getConversation(req.website_id, req.session_id);
    if (!conv) throw new HttpError(404, "Chưa có dữ liệu conversation này");

    const [messages, profiles, operator] = await Promise.all([
      deps.db.getMessages(req.website_id, req.session_id, MESSAGE_LIMIT),
      deps.db.getProfiles(operatorId, req.website_id),
      deps.db.getOperator(operatorId),
    ]);
    const unanswered = unansweredCustomerMessages(messages);
    const { source } = resolveProfile(profiles, conv.topic, ws.default_profile);

    const result: CheckResult = {
      action: "check",
      stale,
      workspace: ws.name,
      topic: conv.topic,
      topic_label: ws.topics.find((t) => t.key === conv.topic)?.label ?? null,
      profile_source: source,
      profile_name: operator?.display_name ?? operatorId,
      needs_reply: unanswered.length > 0,
      unanswered,
      last_customer_at: conv.last_customer_at,
      last_human_operator_at: conv.last_human_operator_at,
      jira: [],
    };
    return { status: 200, body: result };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
    console.error("copilot error", e);
    return { status: 500, body: { error: "Lỗi hệ thống, thử lại sau" } };
  }
}
