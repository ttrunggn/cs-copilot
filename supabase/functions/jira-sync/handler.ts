import { diffLink, doneReportedToCustomer, type JiraIssue, type JiraLink, normalizeIssue } from "../_shared/jira.ts";
import { secretOk } from "../_shared/secret.ts";

export interface JiraStore {
  csNames(): Promise<string[]>;
  /** Lưu issue; trả về hai mốc đã lưu trong DB (mốc đổi trạng thái + trạng thái trước đó). */
  saveIssue(issue: JiraIssue): Promise<{ status_changed_at: string | null; prev_status: string | null }>;
  linksFor(issueKeys: string[]): Promise<JiraLink[]>;
  updateLink(link: JiraLink, patch: Record<string, unknown>): Promise<void>;
  /** Mốc CS người thật nhắn cho khách gần nhất trong chat của link (null = chưa nhắn / không có chat). */
  lastHumanOperatorAt(link: JiraLink): Promise<string | null>;
}

/**
 * n8n gửi kết quả Jira search (fields summary,status,assignee,updated,comment) cho các ticket đang theo dõi.
 * Jira là PANEL-ONLY MIRROR tuyệt đối (Ethan chốt cứng 2026-10-23): handler này CHỈ lưu issue/comment
 * vào DB để panel hiển thị và cập nhật mốc đã thấy của từng link — KHÔNG tạo bất cứ thứ gì trong Crisp
 * (không note theo dõi, không note cập nhật, không note Done). Vì vậy handler không còn dep n8n và
 * không còn đọc cờ jira_auto_note: không tồn tại đường nào từ sync tới Crisp.
 * Ticket Done: KHÔNG tắt link ngay — Done trên Jira ≠ CS đã báo cho khách (Ethan, 2026-10-23),
 * panel cần giữ card kèm nhãn "Chờ báo khách". Link chỉ bị tắt ở đây khi ticket Done VÀ CS đã
 * nhắn cho khách sau mốc chuyển Done (doneReportedToCustomer); phía đọc cũng tự ẩn card trong
 * trường hợp đó nên việc tắt link chỉ là dọn dẹp để ngừng quét.
 */
export async function handleJiraSync(
  secretHeader: string,
  body: unknown,
  deps: { store: JiraStore; secret: string },
): Promise<{ status: number; body: { issues: number } | { error: string } }> {
  if (!secretOk(secretHeader, deps.secret)) return { status: 401, body: { error: "unauthorized" } };
  const rawIssues = Array.isArray((body as { issues?: unknown[] })?.issues) ? (body as { issues: unknown[] }).issues : [];
  const csNames = await deps.store.csNames();
  const issues = rawIssues
    .filter((r): r is { key: string } => typeof r === "object" && r !== null && typeof (r as { key?: unknown }).key === "string")
    .map((r) => normalizeIssue(r, csNames))
    .filter((i) => /^[A-Z][A-Z0-9_]+-\d+$/.test(i.issue_key));
  if (!issues.length) return { status: 200, body: { issues: 0 } };

  const byKey = new Map(issues.map((i) => [i.issue_key, i]));
  const stored = new Map<string, { status_changed_at: string | null; prev_status: string | null }>();
  for (const i of issues) stored.set(i.issue_key, await deps.store.saveIssue(i));
  for (const link of await deps.store.linksFor([...byKey.keys()])) {
    const issue = byKey.get(link.issue_key);
    if (!issue) continue;
    const diff = diffLink(link, issue);
    // Done + đã báo khách (CS nhắn sau mốc Done đã lưu) → khép vòng theo dõi:
    // tắt link để ngừng quét. Done chưa báo → giữ nguyên active, panel còn việc.
    if (diff.done) {
      const seen: JiraIssue = { ...issue, status_changed_at: stored.get(issue.issue_key)?.status_changed_at ?? null };
      if (doneReportedToCustomer(seen, await deps.store.lastHumanOperatorAt(link))) {
        await deps.store.updateLink(link, { active: false });
        continue;
      }
    }
    if (diff.kind === "none") continue;
    const patch: Record<string, unknown> = { ...diff.next, silent_baseline: false };
    await deps.store.updateLink(link, patch);
  }
  return { status: 200, body: { issues: issues.length } };
}
