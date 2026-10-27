import { unansweredCustomerMessages } from "../_shared/context.ts";
import { type ConversationJira, enabledModules, type EnabledModules, jiraForConversation } from "../_shared/jira.ts";
import type { Db } from "../_shared/db.ts";
import { pickBestProfileRow, type ProfileSource, resolveProfile } from "../_shared/profile.ts";
import { resolveReviewTemplate, type ResolvedReviewTemplate } from "../_shared/review.ts";
import type { Sentiment } from "../_shared/sentiment.ts";
import type { StorefrontStoreStatus } from "../_shared/storefront.ts";
import type { Warning, Workspace } from "../_shared/types.ts";
import { sentimentFingerprint } from "./analyze.ts";
import type { CrispClient } from "../_shared/crisp.ts";
import type { JiraClient } from "../_shared/jira-api.ts";
import type { JiraStore } from "../jira-sync/handler.ts";
import { syncJiraForSession } from "./jira-actions.ts";
import { waitUntilBg, writeTrace } from "../_shared/trace.ts";
import { type LoadDeps, loadConversationFast } from "./load.ts";
import { resolveShopDomain, shopFromCustomData } from "./storefront-actions.ts";

/**
 * Deps mở rộng cho check: hai đường TỰ ĐỒNG BỘ khi mở panel (Ethan chốt
 * 2026-10-26). Thiếu từng dep thì đường tương ứng tắt êm — check không bao
 * giờ gãy vì đồng bộ (mirror giữ dữ liệu cũ, panel vẫn hiện).
 */
export type CheckDeps = LoadDeps & {
  jira?: JiraClient | null;
  jiraStore?: JiraStore | null;
  crisp?: CrispClient | null;
};

export interface CheckResult {
  action: "check";
  customer_name: string | null;
  customer_email: string | null;
  shopify_domain: string | null;
  stale: boolean;
  workspace: string;
  topic: string | null;
  topic_label: string | null;
  profile_source: ProfileSource;
  profile_name: string;
  /**
   * Độ phủ dữ liệu học của CHÍNH CS đang trực (từ các dòng agent_profiles của
   * họ): panel hiện công khai để phân biệt "đã học từ N cuộc trò chuyện" với
   * "chưa đủ dữ liệu" (nguyên tắc minh bạch — Ethan, 2026-10-26). null = CS
   * chưa có dòng profile nào.
   */
  profile_coverage: { conversations_used: number; learned_at: string | null } | null;
  /** Template xin review đã phân giải: giọng theo profile của CS (source "profile") hoặc mặc định có ghi nguồn (source "default"); link đã thay theo workspace. */
  review_template: ResolvedReviewTemplate;
  /** Trạng thái Crisp của conversation (unresolved | resolved | pending…); widget dùng để chỉ cảnh báo CSAT khi chat chưa đóng. */
  conversation_state: string | null;
  needs_reply: boolean;
  unanswered: string[];
  pending_messages: { text: string; bot_replied: boolean }[];
  bot_replied_count: number;
  last_customer_at: string | null;
  last_human_operator_at: string | null;
  jira: ConversationJira[];
  /** Module bật theo ngữ cảnh (internal connections): widget chỉ render module được bật. Client cũ bỏ qua trường này vẫn chạy. */
  modules: EnabledModules;
  /**
   * Bản chụp Storefront Watch của store thuộc conversation này (job
   * storefront_sweep ghi vào storefront_store_status): widget hiện badge số
   * lỗi đang mở ngay tại khối Issue logs + cổng Storefront dùng watched để
   * quyết tức thì. CHỈ trả khi workspace bật cờ storefront_watch — ngoài
   * phạm vi SW thì luôn null, badge không được rò sang workspace khác.
   * null = workspace ngoài phạm vi SW, chat không có shopify_domain, hoặc
   * job nền chưa quét tới domain này (khi đó cổng vẫn mở theo domain và
   * action nạp trực tiếp sẽ quyết định — xem enabledModules).
   */
  storefront_status: StorefrontStoreStatus | null;
  sentiment: Sentiment | null;
  /**
   * Sentiment đã lưu KHÔNG còn khớp dấu vân tay tin khách hiện tại (khách đã
   * nhắn thêm, hoặc chưa từng phân tích dù đã có tin) → panel tự gọi analyze
   * khi mở conversation (compute-on-view, Lỗi 5 — 2026-10-26) thay vì chờ
   * precompute qua n8n. false khi không có tin khách dạng text (không có gì
   * để phân tích) hoặc bản lưu đang khớp.
   */
  sentiment_stale: boolean;
  /** Mirror Jira đang thiếu/cũ lúc check chạy — sync nền đang chạy, widget tự nạp lại một lần. */
  jira_stale: boolean;
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
  req: { website_id: string; session_id: string; operator_name?: string },
  ws: Workspace,
  operatorId: string,
  deps: CheckDeps,
): Promise<CheckResult> {
  const { stale, conv, messages } = await loadConversationFast(deps, req.website_id, req.session_id);
  const [profiles, allProfiles, operator, latest, jiraRows0, sentimentRow, csatSend] = await Promise.all([
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
  const profileCoverage = profiles.length
    ? {
      conversations_used: Math.max(...profiles.map((p) => p.conversations_used ?? 0)),
      learned_at: profiles.map((p) => p.learned_at).filter((t): t is string => Boolean(t)).sort().at(-1) ?? null,
    }
    : null;
  // Tự sync Jira khi mở panel — chạy NỀN từ 2026-10-26 (trước đây sync
  // NGAY trong request: mỗi lần mở chat có ticket cũ quá 90s, panel phải
  // chờ trọn một vòng Jira REST mới hiện — một nguyên nhân "tool load
  // chậm" Ethan phàn nàn). Nay: mirror còn tươi thì thôi; mirror thiếu/cũ
  // thì check trả NGAY dữ liệu hiện có kèm cờ jira_stale, sync chạy nền
  // (waitUntil) và widget tự nạp lại một lần sau vài giây để nhận bản mới.
  const jiraRows = jiraRows0;
  const jiraStale = jiraRows0.some((r) => !r.issue || !r.issue.synced_at || Date.now() - Date.parse(r.issue.synced_at) > 90_000);
  if (deps.jira && deps.jiraStore && jiraRows.length && jiraStale) {
    const bg = (async () => {
      const t0 = performance.now();
      try {
        await syncJiraForSession(deps, req.website_id, req.session_id);
        await writeTrace(deps.db, { website_id: req.website_id, session_id: req.session_id, action: "check", kind: "timing", stage: "jira_sync_bg", duration_ms: Math.round(performance.now() - t0) });
      } catch (e) {
        await writeTrace(deps.db, { website_id: req.website_id, session_id: req.session_id, action: "check", kind: "error", stage: "jira_sync_bg", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    waitUntilBg(bg);
  }
  const jira = jiraForConversation(jiraRows, conv.last_human_operator_at);
  // Cổng Storefront đường domain (chỉ workspace trong phạm vi SW —
  // enabledModules khoá bằng cờ ws.storefront_watch): shop lấy từ custom
  // data của CHÍNH conversation này. Bản chụp chỉ được đọc khi cờ bật:
  // ngoài phạm vi SW thì storefront_status luôn null để badge không rò
  // sang workspace khác. Bản chụp lỗi thì coi như chưa có (cổng mở theo
  // domain, action nạp trực tiếp quyết định) — bản chụp là dữ kiện phụ,
  // không được làm gãy check.
  // Domain chưa có trong DB thì thử lấy thẳng từ Crisp meta (resolve tự lưu
  // lại vào DB) — ca ingest chưa mang custom data về kịp, domain có sẵn
  // trong Crisp mà panel vẫn ở trạng thái need_shop (Ethan bắt lỗi live
  // 2026-10-26). Chỉ thử khi workspace thuộc phạm vi SW.
  let shop = shopFromCustomData(conv);
  if (!shop && ws.storefront_watch) {
    shop = await resolveShopDomain(deps, req.website_id, req.session_id, conv).catch(() => "");
  }
  const storefrontStatus = shop && ws.storefront_watch
    ? await deps.db.getStorefrontStoreStatus(req.website_id, shop).catch(() => null)
    : null;
  // Độ tươi của sentiment: so dấu vân tay bản lưu với tin khách hiện tại.
  // Chỉ tốn một lần băm — check vẫn không gọi AI.
  const hasCustomerText = messages.some((m) => m.from === "user" && m.type === "text");
  const sentimentStale = hasCustomerText
    ? !sentimentRow || sentimentRow.input_fp !== await sentimentFingerprint(messages)
    : false;
  return {
    action: "check",
    stale,
    workspace: ws.name,
    customer_name: conv.customer_name ?? null,
    customer_email: conv.customer_email ?? null,
    shopify_domain: shop || null,
    topic: conv.topic,
    topic_label: ws.topics.find((t) => t.key === conv.topic)?.label ?? null,
    profile_source: source,
    profile_name: (req.operator_name ?? "").trim() || operator?.display_name || operatorId,
    profile_coverage: profileCoverage,
    review_template: resolveReviewTemplate(profiles, conv.topic, ws.review_link, allProfiles),
    conversation_state: conv.state,
    needs_reply: unanswered.length > 0,
    unanswered,
    pending_messages: pendingMessages,
    bot_replied_count: pendingMessages.filter((m) => m.bot_replied).length,
    last_customer_at: conv.last_customer_at,
    last_human_operator_at: conv.last_human_operator_at,
    jira,
    modules: enabledModules(jira, ws.jira_project, {
      storefrontWatchEnabled: ws.storefront_watch,
      shopDomain: shop || null,
      snapshotWatched: storefrontStatus ? storefrontStatus.watched : null,
    }),
    storefront_status: storefrontStatus,
    sentiment: sentimentRow ? (({ input_fp: _fp, ...rest }) => rest)(sentimentRow) : null,
    sentiment_stale: sentimentStale,
    jira_stale: jiraStale,
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
