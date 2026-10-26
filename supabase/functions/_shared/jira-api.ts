// Client Jira REST TỐI THIỂU, CHỈ ĐỌC — phục vụ đồng bộ mirror Jira vào
// panel ngay trong Edge Function (Ethan chốt 2026-10-26: mở panel là tự
// sync, CS không phải bấm Sync ngay và không phụ thuộc lịch quét của n8n).
//
// READ-ONLY TUYỆT ĐỐI (luật cứng Ethan 2026-10-23): client này chỉ có đúng
// một thao tác POST /rest/api/3/search/jql — một lời gọi TÌM KIẾM không
// thay đổi gì trên Jira (cùng endpoint workflow n8n dùng trước đây). Không
// thêm bất kỳ method tạo/sửa/chuyển trạng thái/comment nào vào đây.
//
// Kết quả thô (issues với fields summary,status,assignee,updated,comment)
// được trả nguyên cho pipeline chuẩn hoá/lưu sẵn có (jira-sync/handler
// applyJiraIssues → _shared/jira.normalizeIssue + JiraStore) — client này
// không tự diễn giải dữ liệu.

export class JiraApiError extends Error {}

export interface JiraClient {
  /** Tìm các issue theo key; trả mảng issue thô đúng định dạng Jira API. */
  searchIssues(issueKeys: string[]): Promise<unknown[]>;
}

export const JIRA_TIMEOUT_MS = 6_000;
const KEY_OK = /^[A-Z][A-Z0-9_]+-\d+$/;

export function createJiraClient(opts: {
  baseUrl: string;
  email: string;
  apiToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): JiraClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? JIRA_TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const auth = `Basic ${btoa(`${opts.email}:${opts.apiToken}`)}`;
  return {
    async searchIssues(issueKeys) {
      const keys = [...new Set(issueKeys.filter((k) => KEY_OK.test(k)))];
      if (!keys.length) return [];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doFetch(`${base}/rest/api/3/search/jql`, {
          method: "POST",
          headers: { "authorization": auth, "content-type": "application/json", "accept": "application/json" },
          body: JSON.stringify({
            jql: `key in (${keys.join(",")})`,
            fields: ["summary", "status", "assignee", "updated", "comment"],
            maxResults: 100,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new JiraApiError(`Jira search lỗi (HTTP ${res.status})`);
        const parsed = await res.json().catch(() => null) as { issues?: unknown } | null;
        return Array.isArray(parsed?.issues) ? parsed.issues : [];
      } catch (e) {
        if (e instanceof JiraApiError) throw e;
        throw new JiraApiError(`Không gọi được Jira: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Dựng client từ env: JIRA_EMAIL + JIRA_API_TOKEN (bắt buộc), JIRA_BASE_URL
 * (tuỳ chọn — mặc định instance của Transcy; workspace khác đổi qua env,
 * không khoá cứng vào code). Thiếu credential → null, mọi đường sync trả
 * "unconfigured" trung thực thay vì gọi bừa (cùng quy ước crispFromEnv /
 * storefrontFromEnv).
 */
export function jiraFromEnv(getEnv: (key: string) => string | undefined): JiraClient | null {
  const email = (getEnv("JIRA_EMAIL") ?? "").trim();
  const apiToken = (getEnv("JIRA_API_TOKEN") ?? "").trim();
  if (!email || !apiToken) return null;
  const baseUrl = (getEnv("JIRA_BASE_URL") ?? "").trim() || "https://firegroup.atlassian.net";
  return createJiraClient({ baseUrl, email, apiToken });
}
