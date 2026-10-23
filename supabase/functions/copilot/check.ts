import { unansweredCustomerMessages } from "../_shared/context.ts";
import { type ConversationJira, jiraForConversation } from "../_shared/jira.ts";
import type { Db } from "../_shared/db.ts";
import { pickBestProfileRow, type ProfileSource, resolveProfile } from "../_shared/profile.ts";
import type { Sentiment } from "../_shared/sentiment.ts";
import type { Warning, Workspace } from "../_shared/types.ts";
import { type LoadDeps, loadConversationFast } from "./load.ts";

export interface CheckResult {
  action: "check";
  stale: boolean;
  workspace: string;
  topic: string | null;
  topic_label: string | null;
  profile_source: ProfileSource;
  profile_name: string;
  /** Trạng thái Crisp của conversation (unresolved | resolved | pending…); widget dùng để chỉ cảnh báo CSAT khi chat chưa đóng. */
  conversation_state: string | null;
  needs_reply: boolean;
  unanswered: string[];
  pending_messages: { text: string; bot_replied: boolean }[];
  bot_replied_count: number;
  last_customer_at: string | null;
  last_human_operator_at: string | null;
  jira: ConversationJira[];
  sentiment: Sentiment | null;
  csat: { sent: boolean; sent_at: string | null };
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
  deps: LoadDeps,
): Promise<CheckResult> {
  const { stale, conv, messages } = await loadConversationFast(deps, req.website_id, req.session_id);
  const [profiles, allProfiles, operator, latest, jiraRows, sentimentRow, csatSend] = await Promise.all([
    deps.db.getProfiles(operatorId, req.website_id),
    deps.db.getWorkspaceAllProfiles(req.website_id),
    deps.db.getOperator(operatorId),
    deps.db.getLatestDraft(req.website_id, req.session_id, operatorId),
    deps.db.getJiraRows(req.website_id, req.session_id),
    deps.db.getSentiment(req.website_id, req.session_id).catch(() => null),
    deps.db.getCsatSend(req.website_id, req.session_id).catch(() => null),
  ]);
  const unanswered = unansweredCustomerMessages(messages);
  const pendingMessages = pendingCustomerMessages(messages);
  const { source } = resolveProfile(profiles, conv.topic, ws.default_profile, pickBestProfileRow(allProfiles));
  return {
    action: "check",
    stale,
    workspace: ws.name,
    topic: conv.topic,
    topic_label: ws.topics.find((t) => t.key === conv.topic)?.label ?? null,
    profile_source: source,
    profile_name: operator?.display_name ?? operatorId,
    conversation_state: conv.state,
    needs_reply: unanswered.length > 0,
    unanswered,
    pending_messages: pendingMessages,
    bot_replied_count: pendingMessages.filter((m) => m.bot_replied).length,
    last_customer_at: conv.last_customer_at,
    last_human_operator_at: conv.last_human_operator_at,
    jira: jiraForConversation(jiraRows, conv.last_human_operator_at),
    sentiment: sentimentRow ? (({ input_fp: _fp, ...rest }) => rest)(sentimentRow) : null,
    csat: { sent: Boolean(csatSend), sent_at: csatSend?.sent_at ?? null },
    // Draft viết trước tin khách mới nhất là của lượt trước: không hiện để tránh "Điền lại" nhầm.
    latest_draft: latest && (!conv.last_customer_at || Date.parse(latest.created_at) >= Date.parse(conv.last_customer_at))
      ? { output_id: latest.id, content: latest.content, warnings: latest.warnings, verified: latest.verified, helpdesk_matches: latest.helpdesk_matches, created_at: latest.created_at }
      : null,
  };
}

/** Tin khách chờ CS; đánh dấu riêng nếu Bot đã gửi câu trả lời sau tin đó. */
function pendingCustomerMessages(messages: Awaited<ReturnType<Db["getMessages"]>>) {
  const ordered = [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const lastHumanReply = ordered.reduce((last, m, i) =>
    m.from === "operator" && !m.is_bot && m.type !== "note" && m.type !== "event" ? i : last, -1);
  const pending = ordered.slice(lastHumanReply + 1);
  const customerIndices = pending.flatMap((m, i) => m.from === "user" && m.type !== "note" && m.type !== "event" ? [i] : []);
  return customerIndices.map((index, i) => {
    const end = customerIndices[i + 1] ?? pending.length;
    const botReplied = pending.slice(index + 1, end).some((m) => m.from === "operator" && m.is_bot && m.type === "text");
    const customer = pending[index];
    return { text: customer.content, bot_replied: botReplied };
  });
}
