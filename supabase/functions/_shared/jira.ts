// Logic thuần cho Jira: đọc dữ liệu Jira API, phân vai comment, so thay đổi với lần báo trước, soạn note tiếng Việt,
// và dựng ngữ cảnh Jira cho widget/handoff/draft.
import { neutralize } from "./prompts.ts";

export type CommentRole = "tech" | "cs" | "bot";

export interface JiraComment {
  id: string;
  author: string;
  role: CommentRole;
  body_text: string;
  created_at: string;
}

export interface JiraIssue {
  issue_key: string;
  summary: string | null;
  status: string | null;
  status_category: string | null;
  assignee: string | null;
  updated_at: string | null;
  status_changed_at?: string | null;
  comments: JiraComment[];
}

export interface JiraLink {
  website_id: string;
  session_id: string;
  issue_key: string;
  url: string;
  silent_baseline: boolean;
  last_seen_status: string | null;
  last_seen_comment_at: string | null;
}

const IGNORE_AUTHORS = ["Automation for Jira"];
const TZ = "Asia/Ho_Chi_Minh";
const NOTE_COMMENT_CHARS = 500;
const MAX_NOTE_COMMENTS = 5;
const RECENT_COMMENTS = 3;

/** Atlassian Document Format → text (giữ xuống dòng, bullet, mention, ảnh). */
export function adfToText(n: unknown): string {
  if (!n) return "";
  if (typeof n === "string") return n;
  const node = n as { type?: string; text?: string; attrs?: Record<string, string>; content?: unknown[] };
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return node.attrs?.text ?? "";
  if (node.type === "media" || node.type === "mediaInline") return `[Ảnh: ${node.attrs?.alt || "không tên"}]`;
  if (node.type === "inlineCard" || node.type === "blockCard") return node.attrs?.url ?? "";
  const inner = (node.content ?? []).map(adfToText).join("");
  if (node.type === "listItem") return "• " + inner;
  return ["paragraph", "heading", "blockquote", "codeBlock", "mediaSingle"].includes(node.type ?? "") ? inner + "\n" : inner;
}

const lower = (s: string) => s.trim().toLowerCase();

export function commentRole(author: string, csNames: string[], ignore: string[] = IGNORE_AUTHORS): CommentRole {
  if (ignore.some((x) => lower(x) === lower(author))) return "bot";
  return csNames.some((x) => x && lower(x) === lower(author)) ? "cs" : "tech";
}

/** "2026-10-19T02:00:00.000+0700" (Jira) → ISO UTC. */
function iso(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return isNaN(t) ? null : new Date(t).toISOString();
}

// deno-lint-ignore no-explicit-any
export function normalizeIssue(raw: any, csNames: string[]): JiraIssue {
  const f = raw?.fields ?? {};
  // deno-lint-ignore no-explicit-any
  const comments: JiraComment[] = (f.comment?.comments ?? []).map((c: any) => {
    const author = c.author?.displayName ?? "?";
    return { id: String(c.id), author, role: commentRole(author, csNames), body_text: adfToText(c.body).trim(), created_at: iso(c.created) ?? "" };
  }).filter((c: JiraComment) => c.created_at)
    .sort((a: JiraComment, b: JiraComment) => a.created_at.localeCompare(b.created_at));
  return {
    issue_key: String(raw?.key ?? ""),
    summary: f.summary ?? null,
    status: f.status?.name ?? null,
    status_category: f.status?.statusCategory?.key ?? null,
    assignee: f.assignee?.displayName ?? null,
    updated_at: iso(f.updated),
    comments,
  };
}

export interface LinkDiff {
  kind: "first" | "silent" | "update" | "none";
  statusChanged: boolean;
  newComments: JiraComment[];
  done: boolean;
  next: { last_seen_status: string | null; last_seen_comment_at: string | null };
}

/** So ticket hiện tại với mốc đã báo của một chat. Comment bot không tính là cập nhật. */
export function diffLink(link: JiraLink, issue: JiraIssue): LinkDiff {
  const lastAt = issue.comments.at(-1)?.created_at ?? link.last_seen_comment_at;
  const next = { last_seen_status: issue.status, last_seen_comment_at: lastAt };
  const done = issue.status_category === "done";
  if (link.last_seen_status === null) {
    return { kind: link.silent_baseline ? "silent" : "first", statusChanged: false, newComments: [], done, next };
  }
  const since = link.last_seen_comment_at ?? "";
  const newComments = issue.comments.filter((c) => c.role !== "bot" && c.created_at > since);
  const statusChanged = issue.status !== link.last_seen_status;
  return { kind: statusChanged || newComments.length ? "update" : "none", statusChanged, newComments, done, next };
}

function fmt(isoTime: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(isoTime)).map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

const ROLE_LABEL: Record<CommentRole, string> = { tech: "Tech", cs: "CS", bot: "Bot" };
const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** Note tiếng Việt đăng vào chat (postNote tự thêm 🤖 ở đầu). */
export function formatJiraNote(link: JiraLink, issue: JiraIssue, diff: LinkDiff): string {
  const head = [issue.summary ?? "", link.url];
  if (diff.kind === "first" || diff.kind === "silent") {
    const latest = issue.comments.filter((c) => c.role !== "bot").at(-1);
    return [
      `🔗 Đã theo dõi Jira · ${issue.issue_key}`,
      ...head,
      `Trạng thái: ${issue.status ?? "?"}`,
      latest
        ? `Cập nhật mới nhất: ${fmt(latest.created_at)} · ${latest.author} (${ROLE_LABEL[latest.role]}): "${oneLine(latest.body_text, 200)}"`
        : "Cập nhật mới nhất: chưa có comment",
      "Từ giờ copilot tự báo khi ticket đổi trạng thái hoặc có comment mới.",
    ].join("\n");
  }
  const lines = [`🔔 Jira cập nhật · ${issue.issue_key}`, ...head];
  lines.push(diff.statusChanged ? `Trạng thái: ${link.last_seen_status} → ${issue.status}` : `Trạng thái: ${issue.status}`);
  const shown = diff.newComments.slice(-MAX_NOTE_COMMENTS);
  if (shown.length) {
    lines.push("Comment mới:");
    for (const c of shown) lines.push(`• [${ROLE_LABEL[c.role]}] ${c.author} (${fmt(c.created_at)}): ${oneLine(c.body_text, NOTE_COMMENT_CHARS)}`);
    if (diff.newComments.length > shown.length) lines.push(`… và ${diff.newComments.length - shown.length} comment cũ hơn`);
  }
  if (diff.done) lines.push("Ticket đã xong, ngừng theo dõi.");
  return lines.join("\n");
}

export interface ConversationJira {
  issue_key: string;
  url: string;
  summary: string | null;
  status: string | null;
  is_new: boolean;
  status_changed: boolean;
  new_comments: { author: string; role: CommentRole; body: string; created_at: string }[];
  recent_comments: { author: string; role: CommentRole; body: string; created_at: string }[];
}

const view = (c: JiraComment) => ({ author: c.author, role: c.role, body: oneLine(c.body_text, 300), created_at: c.created_at });

/** Ticket của một chat cho widget: có gì mới kể từ lần CS trả lời gần nhất (badge MỚI khi tech có tin hoặc đổi trạng thái). */
export function jiraForConversation(rows: { link: JiraLink; issue: JiraIssue | null }[], lastHumanAt: string | null): ConversationJira[] {
  return rows.map(({ link, issue }) => {
    const human = (issue?.comments ?? []).filter((c) => c.role !== "bot");
    const fresh = lastHumanAt ? human.filter((c) => c.created_at > lastHumanAt) : [];
    const statusChanged = Boolean(lastHumanAt && issue?.status_changed_at && issue.status_changed_at > lastHumanAt);
    return {
      issue_key: link.issue_key,
      url: link.url,
      summary: issue?.summary ?? null,
      status: issue?.status ?? null,
      is_new: statusChanged || fresh.some((c) => c.role === "tech"),
      status_changed: statusChanged,
      new_comments: fresh.map(view),
      recent_comments: human.slice(-RECENT_COMMENTS).map(view),
    };
  });
}

/** Ngữ cảnh Jira cho prompt handoff/draft (dữ liệu, đã neutralize). Rỗng nếu chat không có ticket. */
export function jiraPromptBlock(items: ConversationJira[]): string {
  if (!items.length) return "";
  return items.map((j) => {
    const head = `${neutralize(j.issue_key)} (${neutralize(j.status ?? "unknown status")}): ${neutralize(oneLine(j.summary ?? "", 300))}`;
    const cs = j.recent_comments.map((c) => `  - [${c.role}] ${neutralize(c.author)}: ${neutralize(c.body)}`);
    return [head, ...cs].join("\n");
  }).join("\n");
}
