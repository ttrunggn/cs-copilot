import { diffLink, formatJiraNote, type JiraIssue, type JiraLink, normalizeIssue } from "../_shared/jira.ts";
import type { N8n } from "../_shared/n8n.ts";
import { secretOk } from "../_shared/secret.ts";

export type TrackedLink = JiraLink & { auto_note: boolean };

export interface JiraStore {
  csNames(): Promise<string[]>;
  saveIssue(issue: JiraIssue): Promise<void>;
  linksFor(issueKeys: string[]): Promise<TrackedLink[]>;
  updateLink(link: JiraLink, patch: Record<string, unknown>): Promise<void>;
}

/**
 * n8n gửi kết quả Jira search (fields summary,status,assignee,updated,comment) cho các ticket đang theo dõi.
 * Lưu issue + comment, rồi với mỗi chat theo dõi ticket: có thay đổi so với lần báo trước thì đăng note.
 * Đăng note lỗi thì giữ nguyên mốc để lần sau báo lại. Ticket Done: báo lần cuối rồi ngừng theo dõi.
 */
export async function handleJiraSync(
  secretHeader: string,
  body: unknown,
  deps: { store: JiraStore; n8n: N8n; secret: string },
): Promise<{ status: number; body: { issues: number; notes: number } | { error: string } }> {
  if (!secretOk(secretHeader, deps.secret)) return { status: 401, body: { error: "unauthorized" } };
  const rawIssues = Array.isArray((body as { issues?: unknown[] })?.issues) ? (body as { issues: unknown[] }).issues : [];
  const csNames = await deps.store.csNames();
  const issues = rawIssues
    .filter((r): r is { key: string } => typeof r === "object" && r !== null && typeof (r as { key?: unknown }).key === "string")
    .map((r) => normalizeIssue(r, csNames))
    .filter((i) => /^[A-Z][A-Z0-9_]+-\d+$/.test(i.issue_key));
  if (!issues.length) return { status: 200, body: { issues: 0, notes: 0 } };

  const byKey = new Map(issues.map((i) => [i.issue_key, i]));
  for (const i of issues) await deps.store.saveIssue(i);
  let notes = 0;
  for (const link of await deps.store.linksFor([...byKey.keys()])) {
    const issue = byKey.get(link.issue_key);
    if (!issue) continue;
    const diff = diffLink(link, issue);
    if (diff.kind === "none") continue;
    const announce = link.auto_note && (diff.kind === "first" || diff.kind === "update");
    const patch: Record<string, unknown> = { ...diff.next, silent_baseline: false };
    if (announce) {
      if (!(await deps.n8n.postNote(link.website_id, link.session_id, formatJiraNote(link, issue, diff)))) continue;
      patch.last_notified_at = new Date().toISOString();
      notes++;
    }
    if (diff.done) patch.active = false;
    await deps.store.updateLink(link, patch);
  }
  return { status: 200, body: { issues: issues.length, notes } };
}
