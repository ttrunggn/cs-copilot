import { HttpError } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";

// Định dạng issue key Jira (khớp bộ lọc ở workflow n8n và jira-sync handler):
// chữ hoa/số/gạch dưới, gạch ngang, số — chặn key rác/chèn ký tự lạ từ client.
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export interface JiraSyncNowResult {
  action: "jira_sync_now";
  triggered: boolean;
  /** Lý do kích hoạt không thành (khi triggered = false) để panel hiện đúng thay vì đoán. */
  error: string | null;
}

export interface JiraUnlinkResult {
  action: "jira_unlink";
  issue_key: string;
  /** true = có link đang active bị gỡ; false = chat này không (còn) theo dõi ticket đó. */
  removed: boolean;
}

/**
 * Nút "Sync ngay" trên panel: kích hoạt workflow Jira Sync qua webhook
 * jira-sync-now thay vì chờ lịch 5 phút. Chỉ kích hoạt — lượt quét chạy bất
 * đồng bộ bên n8n, panel tự check lại sau ít giây. Webhook không phản hồi
 * {"ok": true} (chưa import node webhook / workflow chưa Active / sai secret)
 * thì trả triggered=false kèm lý do, không nuốt lỗi.
 */
export async function runJiraSyncNow(
  req: { website_id: string; session_id: string },
  deps: { n8n: N8n },
): Promise<JiraSyncNowResult> {
  const triggered = await deps.n8n.triggerJiraSync(req.website_id, req.session_id);
  if (!triggered) {
    return {
      action: "jira_sync_now",
      triggered: false,
      error: "Không kích hoạt được lượt quét Jira (kiểm tra workflow Jira Sync đã Active và đã có node webhook jira-sync-now trên n8n).",
    };
  }
  return { action: "jira_sync_now", triggered: true, error: null };
}

/**
 * CS gỡ một ticket khỏi panel của chat này: chỉ set active=false đúng dòng
 * jira_links của (website_id, session_id, issue_key) — không đụng Jira
 * (read-only), không ảnh hưởng chat khác đang theo dõi cùng ticket.
 */
export async function runJiraUnlink(
  req: { website_id: string; session_id: string; issue_key: string },
  deps: { db: Db },
): Promise<JiraUnlinkResult> {
  if (!ISSUE_KEY.test(req.issue_key)) throw new HttpError(400, `issue_key không hợp lệ: ${req.issue_key}`);
  const removed = await deps.db.unlinkJira(req.website_id, req.session_id, req.issue_key);
  return { action: "jira_unlink", issue_key: req.issue_key, removed };
}
