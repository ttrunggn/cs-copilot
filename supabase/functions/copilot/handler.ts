import { authorize, authorizeWidget, HttpError } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import { type Ai, AiBadOutput, AiUnavailable } from "../_shared/gemini.ts";
import type { N8n } from "../_shared/n8n.ts";
import { type DraftTone, parseDraftTone } from "../_shared/prompts.ts";
import { runAnalyze } from "./analyze.ts";
import { runAsk } from "./ask.ts";
import { runCheck } from "./check.ts";
import { runSurvey } from "./survey.ts";
import { runGenerate } from "./generate.ts";
import { runHandoff } from "./handoff.ts";
import { runJiraSyncNow, runJiraUnlink } from "./jira-actions.ts";
import type { CrispClient } from "../_shared/crisp.ts";
import type { JiraClient } from "../_shared/jira-api.ts";
import type { JiraStore } from "../jira-sync/handler.ts";
import type { StorefrontMcp } from "../_shared/storefront.ts";
import { runStorefront, runStorefrontAct, runStorefrontFinding, SF_NOTE_MAX } from "./storefront-actions.ts";
import { newFlowId, writeTrace } from "../_shared/trace.ts";
import { runSaveSuggestion, SUGGESTION_TEXT_MAX } from "./suggestions.ts";

export type { AskResult } from "./ask.ts";
export type { CheckResult } from "./check.ts";
export type { GenerateResult } from "./generate.ts";
export type { HandoffResult } from "./handoff.ts";
export type { JiraSyncNowResult, JiraUnlinkResult } from "./jira-actions.ts";
export type { StorefrontActResult, StorefrontFindingResult, StorefrontResult } from "./storefront-actions.ts";
export type { SaveSuggestionResult } from "./suggestions.ts";

const ACTIONS = ["check", "handoff", "generate", "analyze", "survey", "ask", "jira_sync_now", "jira_unlink", "storefront", "storefront_finding", "storefront_act", "save_suggestion"] as const;
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
  /** Tên account CS đang đăng nhập do widget đọc từ SDK Crisp — nguồn chuẩn cho
   * tên trong draft/panel; DB `operators.display_name` chỉ là dự phòng. */
  operator_name: string;
  /** Ý CS gõ thêm cho draft (chỉ action generate dùng). Trần 500 ký tự. */
  hint: string;
  /** Giọng văn CS chọn cho draft; không hợp lệ → default. */
  tone: DraftTone;
  /** Câu hỏi của CS cho Hỏi tài liệu (chỉ action ask dùng). Trần 300 ký tự. */
  question: string;
  /** Ticket cần gỡ khỏi panel (chỉ action jira_unlink dùng; validate định dạng ở runJiraUnlink). */
  issue_key: string;
  /** Store cần kiểm tra (chỉ action storefront dùng; tuỳ chọn — widget truyền domain/link khi CS nhập tay, không truyền thì server tự resolve từ custom_data.shopify_domain của phiên; trần 300 ký tự như inputSchema của find_store). */
  shop: string;
  /** Finding cần xem chi tiết (chỉ action storefront_finding dùng; validate 40-hex ở runStorefrontFinding). */
  fingerprint: string;
  /** Thao tác ghi lên finding (chỉ action storefront_act dùng): acknowledge | fixed | dismiss | undo — validate ở runStorefrontAct. */
  sf_act: string;
  /** Ghi chú của CS kèm quyết định Fixed/Dismiss (chỉ action storefront_act dùng; bắt buộc với fixed/dismiss). */
  note: string;
  /** Lý do Dismiss (chỉ action storefront_act dùng): false_signal | not_important. */
  reason: string;
  /** Loại mẫu CS lưu từ thẻ gợi ý (chỉ action save_suggestion dùng): draft | review. */
  suggestion_kind: string;
  /** Nội dung mẫu CS đã duyệt để lưu (chỉ action save_suggestion dùng). */
  suggestion_text: string;
}

export const HINT_MAX_CHARS = 500;
export const QUESTION_MAX_CHARS = 300;

export interface Deps {
  db: Db;
  n8n: N8n;
  ai: Ai;
  /** Client MCP Storefront Watch; null/vắng = server chưa cấu hình SW_API_TOKEN + SW_MCP_SIGNING_SECRET (action trả unconfigured). */
  storefront?: StorefrontMcp | null;
  /** Client Jira REST chỉ-đọc (tự sync khi mở panel); null/vắng = chưa cấu hình JIRA_EMAIL + JIRA_API_TOKEN. */
  jira?: JiraClient | null;
  /** Kho lưu mirror Jira (áp kết quả sync qua applyJiraIssues). */
  jiraStore?: JiraStore | null;
  /** Client REST Crisp — trong đường widget CHỈ dùng thao tác ĐỌC meta (tự resolve shopify_domain); null/vắng = bỏ đường dự phòng đó. */
  crisp?: CrispClient | null;
  /** Hash token widget phụ được chấp nhận thêm ở authorizeWidget (mặc định không có; chỉ function test truyền cho plugin survey). */
  extraWidgetTokenHashes?: string[];
  /** Module Storefront Watch có được hiện trên PANEL hay không (Ethan chốt 2026-11-03: panel chính của team không cần SW nữa, SW chỉ sống ở tool thu nhỏ trên bề mặt test). index.ts truyền theo bề mặt triển khai: /copilot-test = true, production = false. Vắng mặt = bật như cũ (test đơn vị và các đường gọi trực tiếp không đổi hành vi). Đây là cổng HIỂN THỊ ở check — các action storefront và luồng nền (sweep/digest/segment) không qua cổng này. */
  storefrontPanelEnabled?: boolean;
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
    operator_name: str("operator_name").slice(0, 80),
    hint: str("hint").slice(0, HINT_MAX_CHARS),
    tone: parseDraftTone(b.tone),
    question: str("question").slice(0, QUESTION_MAX_CHARS),
    issue_key: str("issue_key"),
    shop: str("shop").slice(0, 300),
    fingerprint: str("fingerprint"),
    sf_act: str("sf_act"),
    note: str("note").slice(0, SF_NOTE_MAX),
    reason: str("reason"),
    suggestion_kind: str("suggestion_kind"),
    suggestion_text: str("suggestion_text").slice(0, SUGGESTION_TEXT_MAX),
  };
}

async function handleInner(body: unknown, token: string, deps: Deps): Promise<{ status: number; body: unknown }> {
  try {
    const req = parseRequest(body);
    // Token cá nhân (curl/tooling) hoặc widget trong Crisp (token website + operator từ SDK).
    const { workspace: ws, operatorId } = token
      ? await authorize(deps.db, { website_id: req.website_id, token })
      : await authorizeWidget(deps.db, req, deps.extraWidgetTokenHashes ?? []);
    switch (req.action) {
      case "check":
        return { status: 200, body: await runCheck(req, ws, operatorId, deps) };
      case "handoff":
        return { status: 200, body: await runHandoff(req, ws, operatorId, deps) };
      case "generate":
        return { status: 200, body: await runGenerate(req, ws, operatorId, deps) };
      case "analyze":
        return { status: 200, body: await runAnalyze(req, deps) };
      case "survey":
        return { status: 200, body: await runSurvey(req, operatorId, deps) };
      case "ask":
        return { status: 200, body: await runAsk(req, deps) };
      case "jira_sync_now":
        return { status: 200, body: await runJiraSyncNow(req, deps) };
      case "jira_unlink":
        return { status: 200, body: await runJiraUnlink(req, deps) };
      case "storefront":
        return { status: 200, body: await runStorefront(req, ws, deps) };
      case "storefront_finding":
        return { status: 200, body: await runStorefrontFinding(req, ws, deps) };
      case "storefront_act":
        return { status: 200, body: await runStorefrontAct(req, ws, deps) };
      case "save_suggestion":
        return { status: 200, body: await runSaveSuggestion(req, operatorId, deps) };
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

/**
 * handle() công khai = handleInner bọc truy vết (migration 028, Ethan chốt
 * 2026-10-26 "làm gì cũng cần truy vết"): mỗi request ghi 1 dòng timing
 * (action + tổng thời gian thực thi); response lỗi (status >= 400) ghi thêm
 * 1 dòng error kèm message. writeTrace tự nuốt lỗi nên tracing hỏng cũng
 * không làm gãy request.
 */
export async function handle(body: unknown, token: string, deps: Deps): Promise<{ status: number; body: unknown }> {
  const t0 = performance.now();
  const meta = (body && typeof body === "object") ? body as Record<string, unknown> : {};
  const base = {
    website_id: typeof meta.website_id === "string" ? meta.website_id : null,
    session_id: typeof meta.session_id === "string" ? meta.session_id : null,
    action: typeof meta.action === "string" ? meta.action : "unknown",
    // Khung truy vết (migration 032): một request = một flow_id, cả dòng
    // timing lẫn dòng error của request này mang cùng mã để truy toàn bộ lượt.
    flow_id: newFlowId(typeof meta.action === "string" ? meta.action : "unknown"),
  };
  const r = await handleInner(body, token, deps);
  const duration_ms = Math.round(performance.now() - t0);
  await writeTrace(deps.db, { ...base, kind: "timing", stage: "handler", duration_ms });
  if (r.status >= 400) {
    const msg = (r.body as { error?: unknown } | null)?.error;
    await writeTrace(deps.db, { ...base, kind: "error", stage: "handler", duration_ms, message: typeof msg === "string" ? msg : `HTTP ${r.status}` });
  }
  return r;
}
