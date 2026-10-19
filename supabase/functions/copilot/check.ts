import { unansweredCustomerMessages } from "../_shared/context.ts";
import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";
import { type ProfileSource, resolveProfile } from "../_shared/profile.ts";
import type { Warning, Workspace } from "../_shared/types.ts";
import { loadConversation } from "./load.ts";

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
  latest_draft: {
    output_id: number;
    content: string;
    warnings: Warning[];
    verified: boolean | null;
    helpdesk_matches: number | null;
    created_at: string;
  } | null;
}

/** Không gọi AI: tin chờ trả lời, topic, profile sẽ dùng. Hiển thị nguyên văn tin khách. */
export async function runCheck(
  req: { website_id: string; session_id: string },
  ws: Workspace,
  operatorId: string,
  deps: { db: Db; n8n: N8n },
): Promise<CheckResult> {
  const { stale, conv, messages } = await loadConversation(deps, req.website_id, req.session_id);
  const [profiles, operator, latest] = await Promise.all([
    deps.db.getProfiles(operatorId, req.website_id),
    deps.db.getOperator(operatorId),
    deps.db.getLatestDraft(req.website_id, req.session_id, operatorId),
  ]);
  const unanswered = unansweredCustomerMessages(messages);
  const { source } = resolveProfile(profiles, conv.topic, ws.default_profile);
  return {
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
    // Draft viết trước tin khách mới nhất là của lượt trước: không hiện để tránh "Điền lại" nhầm.
    latest_draft: latest && (!conv.last_customer_at || Date.parse(latest.created_at) >= Date.parse(conv.last_customer_at))
      ? { output_id: latest.id, content: latest.content, warnings: latest.warnings, verified: latest.verified, helpdesk_matches: latest.helpdesk_matches, created_at: latest.created_at }
      : null,
  };
}
