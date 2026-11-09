import { HttpError } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { JiraClient } from "../_shared/jira-api.ts";
import { applyJiraIssues, type JiraStore } from "../jira-sync/handler.ts";

// Định dạng issue key Jira (khớp bộ lọc ở workflow n8n và jira-sync handler):
// chữ hoa/số/gạch dưới, gạch ngang, số — chặn key rác/chèn ký tự lạ từ client.
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export interface JiraSyncNowResult {
  action: "jira_sync_now";
  triggered: boolean;
  /** Lý do đồng bộ không thành (khi triggered = false) để panel hiện đúng thay vì đoán. */
  error: string | null;
}

export interface JiraUnlinkResult {
  action: "jira_unlink";
  issue_key: string;
  /** true = có link đang active bị gỡ; false = chat này không (còn) theo dõi ticket đó. */
  removed: boolean;
}

/**
 * Mirror Jira coi là còn tươi trong khoảng này: mở panel mà bản lưu mới hơn
 * thì khỏi gọi Jira lại (mở/refresh liên tục không nện API). Quá mốc này —
 * hoặc ticket chưa từng có dữ liệu — mở panel là tự sync ngay trong request
 * check (CS không click thủ công, không chờ lịch quét của n8n).
 */
export const JIRA_FRESH_MS = 90_000;

export interface JiraSyncDeps {
  db: Db;
  /** Kho lưu mirror (createJiraStore) — dùng chung pipeline với jira-sync. */
  jiraStore?: JiraStore | null;
  /** Client Jira REST chỉ-đọc; null = chưa cấu hình JIRA_EMAIL/JIRA_API_TOKEN. */
  jira?: JiraClient | null;
  now?: () => number;
}

/**
 * Đồng bộ mirror Jira cho ĐÚNG các ticket đang liên kết với conversation
 * này: lấy issue thô từ Jira REST rồi áp qua applyJiraIssues (cùng pipeline
 * chuẩn hoá/lưu/diff như đường n8n — CHỈ MỘT nguồn sync active tại một
 * thời điểm). force = bỏ qua cửa sổ tươi (nút Sync
 * ngay). Lỗi gọi Jira văng ra cho caller quyết (check nuốt lỗi giữ dữ liệu
 * cũ; sync_now báo lỗi trung thực).
 */
export async function syncJiraForSession(
  deps: JiraSyncDeps,
  websiteId: string,
  sessionId: string,
  opts: { force?: boolean } = {},
): Promise<{ synced: boolean; reason: "no_links" | "fresh" | "unconfigured" | "synced" }> {
  const rows = await deps.db.getJiraRows(websiteId, sessionId);
  if (!rows.length) return { synced: false, reason: "no_links" };
  const now = (deps.now ?? Date.now)();
  const staleKeys = rows
    .filter((r) => !r.issue || !r.issue.synced_at || now - Date.parse(r.issue.synced_at) > JIRA_FRESH_MS)
    .map((r) => r.link.issue_key);
  const keys = opts.force ? rows.map((r) => r.link.issue_key) : staleKeys;
  if (!keys.length) return { synced: false, reason: "fresh" };
  if (!deps.jira || !deps.jiraStore) return { synced: false, reason: "unconfigured" };
  const raw = await deps.jira.searchIssues(keys);
  await applyJiraIssues(deps.jiraStore, { issues: raw });
  return { synced: true, reason: "synced" };
}

const UNCONFIGURED_MSG = "Server chưa cấu hình Jira API (cần JIRA_EMAIL + JIRA_API_TOKEN trong Supabase secrets) nên chưa tự đồng bộ được.";

/**
 * Nút "Sync ngay" trên panel: nay là ép đồng bộ NGAY trong Edge Function
 * (không qua webhook n8n nữa) — panel check lại sau là thấy dữ liệu mới.
 * Chưa cấu hình credential hoặc Jira lỗi → triggered=false kèm lý do, không
 * nuốt lỗi.
 */
export async function runJiraSyncNow(
  req: { website_id: string; session_id: string },
  deps: JiraSyncDeps,
): Promise<JiraSyncNowResult> {
  if (!deps.jira || !deps.jiraStore) {
    return { action: "jira_sync_now", triggered: false, error: UNCONFIGURED_MSG };
  }
  try {
    await syncJiraForSession(deps, req.website_id, req.session_id, { force: true });
    return { action: "jira_sync_now", triggered: true, error: null };
  } catch (e) {
    return {
      action: "jira_sync_now",
      triggered: false,
      error: `Không đồng bộ được Jira: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
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
