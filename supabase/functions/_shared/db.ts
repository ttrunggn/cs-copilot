import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { STOREFRONT_WATCH_SEGMENT } from "./crisp.ts";
import type { AiStore } from "./gemini.ts";
import type { HelpdeskStore } from "../embed-helpdesk/handler.ts";
import type { JiraStore } from "../jira-sync/handler.ts";
import type { JiraComment, JiraIssue, JiraLink } from "./jira.ts";
import { isPlausibleShop, type StorefrontStoreStatus } from "./storefront.ts";
import type { CaseMatch, ConversationRow, HelpdeskChunk, MessageRow, NewOutput, OutputRow, ProfileRow, Variant, Workspace } from "./types.ts";
import type { Sentiment } from "./sentiment.ts";

const OUTPUT_COLUMNS = "id,kind,content,warnings,verified,helpdesk_matches,topic,prompt_version,posted,created_at";
const CACHE_HOURS = 24;

/** Một conversation ứng viên cho job đồng bộ segment `storefront-watch` (xem getStorefrontSegmentCandidates). */
export interface StorefrontSegmentCandidate {
  session_id: string;
  /** shopify_domain đã trích từ custom_data và qua isPlausibleShop; null = không có domain hợp lệ. */
  shop: string | null;
  /** Segments đang mirror trong DB — chỉ để tính diff, không phải nguồn để ghi. */
  segments: string[];
}

export interface TraceRow {
  website_id?: string | null;
  session_id?: string | null;
  action?: string | null;
  kind: "timing" | "error";
  stage?: string | null;
  duration_ms?: number | null;
  message?: string | null;
  detail?: Record<string, unknown> | null;
  /** Mã luồng (migration 032): mọi stage của cùng một lượt vận hành mang cùng flow_id. */
  flow_id?: string | null;
}

/** Một lần đo sentiment MỚI được ghi vào sentiment_history (migration 032, append-only). */
export interface SentimentHistoryRow extends Sentiment {
  website_id: string;
  session_id: string;
  input_fp: string;
  model: string | null;
  /** Nguồn kích hoạt lần đo: analyze | precompute | generate | unknown. */
  source: string;
}

export interface Db {
  /** Ghi truy vết (migration 028). Lỗi ghi log được nuốt ở writeTrace — impl cứ throw như thường. */
  logTrace(row: TraceRow): Promise<void>;
  getWorkspace(websiteId: string): Promise<Workspace | null>;
  getWidgetTokenHash(websiteId: string): Promise<string | null>;
  getOperatorIdByTokenHash(tokenHash: string): Promise<string | null>;
  isOperatorMember(operatorId: string, websiteId: string): Promise<boolean>;
  getConversation(websiteId: string, sessionId: string): Promise<ConversationRow | null>;
  getMessages(websiteId: string, sessionId: string, limit: number): Promise<MessageRow[]>;
  saveTranslations(rows: { id: number; content_en: string }[]): Promise<void>;
  getProfiles(operatorId: string, websiteId: string): Promise<ProfileRow[]>;
  getWorkspaceAllProfiles(websiteId: string): Promise<ProfileRow[]>;
  getOperator(operatorId: string): Promise<{ display_name: string | null } | null>;
  findCachedOutput(q: { websiteId: string; sessionId: string; operatorId: string; kind: "draft" | "handoff"; inputFp: string }): Promise<OutputRow | null>;
  insertOutput(row: NewOutput): Promise<number>;
  /** CS duyệt "Lưu làm mẫu mới" cho template review: ghi text thành review_template của CHÍNH CS trong workspace, xoá gợi ý, và đánh dấu manual_override.review_template_manual = true để học lại không ghi đè (migration 027). */
  saveReviewTemplate(operatorId: string, websiteId: string, text: string): Promise<void>;
  /** Mẫu CS đã duyệt lưu từ luồng Draft/Review (bảng profile_style_samples, migration 027): đầu vào ưu tiên cho vòng học profile sau này. */
  addStyleSample(operatorId: string, websiteId: string, kind: "draft" | "review", text: string): Promise<void>;
  getLatestDraft(websiteId: string, sessionId: string, operatorId: string): Promise<OutputRow | null>;
  setAiTopic(websiteId: string, sessionId: string, topic: string): Promise<void>;
  matchHelpdesk(websiteId: string, embedding: number[], k: number): Promise<HelpdeskChunk[]>;
  /** Hybrid search helpdesk (migration 030): vector + full-text (tsvector) gộp hạng RRF trong DB. Trả chunk kèm score (RRF) và ftsRank (null = không khớp full-text). Dùng cho action ask; draft vẫn đi matchHelpdesk thuần vector. */
  hybridMatchHelpdesk(websiteId: string, query: string, embedding: number[], k: number): Promise<HelpdeskChunk[]>;
  matchCases(websiteId: string, embedding: number[], k: number): Promise<CaseMatch[]>;
  getVariants(task: "draft"): Promise<Variant[]>;
  getJiraRows(websiteId: string, sessionId: string): Promise<{ link: JiraLink; issue: JiraIssue | null }[]>;
  /**
   * Merge patch vào conversations.custom_data của một phiên (đọc hiện tại →
   * merge → ghi lại; chỉ cập nhật khi dòng đã tồn tại, không tự tạo dòng —
   * dòng conversation do ingest tạo). Dùng cho đường tự resolve
   * shopify_domain từ Crisp khi ingest chưa mang về kịp. true = đã ghi.
   */
  mergeConversationCustomData(websiteId: string, sessionId: string, patch: Record<string, unknown>): Promise<boolean>;
  /** Gỡ theo dõi một ticket khỏi một chat (active=false đúng dòng website+session+key). true = có dòng bị gỡ. */
  unlinkJira(websiteId: string, sessionId: string, issueKey: string): Promise<boolean>;
  getSentiment(websiteId: string, sessionId: string): Promise<(Sentiment & { input_fp: string }) | null>;
  /** Ghi 1 dòng lịch sử đo sentiment (migration 032, append-only). Chỉ gọi khi vừa tính MỚI, không gọi ở cache hit. */
  appendSentimentHistory(row: SentimentHistoryRow): Promise<void>;
  /** Các lần đo sentiment gần nhất của một conversation, mới nhất trước — dữ kiện trend cho panel gộp. */
  getSentimentHistory(websiteId: string, sessionId: string, limit: number): Promise<(Sentiment & { input_fp: string; source: string; created_at: string })[]>;
  saveSentiment(row: Sentiment & { website_id: string; session_id: string; input_fp: string; model: string | null }): Promise<void>;
  /** Fingerprint Storefront Watch đã từng hiện trên panel của workspace (mốc chia Mới / Đã xác nhận). */
  getStorefrontSeen(websiteId: string): Promise<string[]>;
  /** Ghi mốc đã thấy: fingerprint mới được insert, fingerprint cũ chỉ cập nhật last_seen_at. */
  markStorefrontSeen(websiteId: string, fingerprints: string[]): Promise<void>;
  /** Bản chụp trạng thái SW của một store (job storefront_sweep ghi); null = job chưa quét tới domain này. */
  getStorefrontStoreStatus(websiteId: string, shop: string): Promise<StorefrontStoreStatus | null>;
  /** Ghi/đè bản chụp trạng thái store theo PK (website_id, shop) — job sweep chạy lại không nhân dữ liệu. */
  upsertStorefrontStoreStatus(row: StorefrontStoreStatus): Promise<void>;
  /** Các shopify_domain DUY NHẤT trong custom_data của các conversation cập nhật trong `days` ngày gần nhất (job sweep quét tập này). */
  getRecentShopDomains(websiteId: string, days: number): Promise<string[]>;
  /** Toàn bộ bản chụp SW của workspace (job gắn segment đọc để biết store nào đủ điều kiện mang segment). */
  listStorefrontStoreStatus(websiteId: string): Promise<StorefrontStoreStatus[]>;
  /** Mốc digest Storefront Watch của một store (migration 031); null = store chưa có mốc nền. */
  getDigestState(websiteId: string, shop: string): Promise<{ last_good_check: string | null } | null>;
  /** Ghi mốc digest cho store (upsert theo PK website_id+shop). */
  setDigestState(websiteId: string, shop: string, lastGoodCheck: string | null): Promise<void>;
  /** Các fingerprint digest đã tính cho store (đã thuộc mốc nền hoặc đã báo qua email). */
  getDigestFindings(websiteId: string, shop: string): Promise<string[]>;
  /** Ghi thêm fingerprint vào tập đã tính của digest (trùng PK thì bỏ qua). */
  addDigestFindings(websiteId: string, shop: string, fingerprints: string[]): Promise<void>;
  /** session_id của conversation MỚI NHẤT có custom_data.shopify_domain = shop (link Crisp trong email digest); null = store chưa từng có session nào. */
  getLatestSessionForShop(websiteId: string, shop: string): Promise<string | null>;
  /**
   * Ứng viên đồng bộ segment `storefront-watch`: (a) các conversation cập
   * nhật trong `days` ngày gần nhất có shopify_domain hợp lệ (kèm shop đã
   * trích), và (b) MỌI conversation đang mang segment đó trong mirror DB —
   * kể cả đã cũ hơn cửa sổ — để gỡ khi store hết điều kiện. Segments ở đây
   * là bản MIRROR (ingest bắt session:set_segments), chỉ để tính diff;
   * trước khi ghi, job đọc lại bản thật từ Crisp API.
   */
  getStorefrontSegmentCandidates(websiteId: string, days: number): Promise<StorefrontSegmentCandidate[]>;
  /** Resolve operator (crisp_user_id) theo email — dùng cho hook của mặt native Crisp (Generic Widget), nơi Crisp chỉ gắn được email của CS qua data binding, không có crisp_user_id. null = không có operator nào mang email này. */
  getOperatorIdByEmail(email: string): Promise<string | null>;
  /**
   * Lần "xin review" gần nhất của conversation theo bảng outputs (kind
   * "review"). LƯU Ý: hiện CHƯA có đường nào ghi outputs kind "review" —
   * xin review là insert-only qua extension (CS tự gửi), server không ghi
   * nhận. Method này tồn tại để mặt native có nguồn đọc chuẩn; khi nào có
   * writer ghi kind "review" thì trạng thái tự đúng, không phải sửa reader.
   */
  getReviewSend(websiteId: string, sessionId: string): Promise<{ sent_at: string } | null>;
  getCsatSend(websiteId: string, sessionId: string): Promise<{ sent_by: string; sent_at: string } | null>;
  /**
   * Claim quyền gửi CSAT cho conversation: insert ignoreDuplicates trên PK
   * (website_id, session_id) — trả dòng vừa insert nếu claim thắng, null nếu
   * đã có dòng (đã gửi hoặc request khác đang giữ claim). runSurvey claim
   * TRƯỚC khi gọi n8n để hai request đồng thời không cùng gửi survey.
   */
  recordCsatSend(websiteId: string, sessionId: string, operatorId: string): Promise<{ sent_at: string } | null>;
  /** Nhả claim CSAT khi lượt gửi chắc chắn không thành — để CS bấm gửi lại được. */
  releaseCsatSend(websiteId: string, sessionId: string): Promise<void>;
}

export function createDb(sb: SupabaseClient): Db {
  return {
    async getWorkspace(websiteId) {
      const { data, error } = await sb.from("workspaces")
        .select("website_id,name,topics,default_profile,jira_project,storefront_watch,review_link")
        .eq("website_id", websiteId).maybeSingle();
      if (error) throw error;
      return data as Workspace | null;
    },
    async logTrace(row) {
      const { error } = await sb.from("trace_log").insert({
        website_id: row.website_id ?? null,
        session_id: row.session_id ?? null,
        action: row.action ?? null,
        kind: row.kind,
        stage: row.stage ?? null,
        duration_ms: row.duration_ms ?? null,
        message: row.message ?? null,
        detail: row.detail ?? null,
        flow_id: row.flow_id ?? null,
      });
      if (error) throw error;
    },
    async getWidgetTokenHash(websiteId) {
      const { data, error } = await sb.from("workspaces").select("crisp_widget_token_hash")
        .eq("website_id", websiteId).maybeSingle();
      if (error) throw error;
      return (data?.crisp_widget_token_hash as string | undefined) ?? null;
    },
    async getOperatorIdByTokenHash(tokenHash) {
      const { data, error } = await sb.from("operators").select("crisp_user_id")
        .eq("copilot_token_hash", tokenHash).maybeSingle();
      if (error) throw error;
      return (data?.crisp_user_id as string | undefined) ?? null;
    },
    async isOperatorMember(operatorId, websiteId) {
      const { data, error } = await sb.from("operator_workspaces").select("active")
        .eq("crisp_user_id", operatorId).eq("website_id", websiteId).maybeSingle();
      if (error) throw error;
      return data?.active === true;
    },
    async getConversation(websiteId, sessionId) {
      const { data, error } = await sb.from("conversations")
        .select("website_id,session_id,customer_email,customer_name,topic,topic_source,state,last_customer_at,last_human_operator_at,updated_at,custom_data")
        .eq("website_id", websiteId).eq("session_id", sessionId).maybeSingle();
      if (error) throw error;
      return data as ConversationRow | null;
    },
    async getMessages(websiteId, sessionId, limit) {
      const { data, error } = await sb.from("messages")
        .select("id,from,type,is_bot,content,content_en,created_at,operator_name")
        .eq("website_id", websiteId).eq("session_id", sessionId)
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return ((data ?? []) as MessageRow[]).reverse();
    },
    async saveTranslations(rows) {
      for (const r of rows) {
        const { error } = await sb.from("messages").update({ content_en: r.content_en }).eq("id", r.id);
        if (error) throw error;
      }
    },
    async getProfiles(operatorId, websiteId) {
      const { data, error } = await sb.from("agent_profiles").select("*")
        .eq("crisp_user_id", operatorId).eq("website_id", websiteId);
      if (error) throw error;
      return (data ?? []) as ProfileRow[];
    },
    async getWorkspaceAllProfiles(websiteId) {
      const { data, error } = await sb.from("agent_profiles").select("*")
        .eq("website_id", websiteId).eq("topic", "_all");
      if (error) throw error;
      return (data ?? []) as ProfileRow[];
    },
    async getOperator(operatorId) {
      const { data, error } = await sb.from("operators").select("display_name")
        .eq("crisp_user_id", operatorId).maybeSingle();
      if (error) throw error;
      return data as { display_name: string | null } | null;
    },
    async findCachedOutput(q) {
      const since = new Date(Date.now() - CACHE_HOURS * 3600_000).toISOString();
      const { data, error } = await sb.from("outputs").select(OUTPUT_COLUMNS)
        .eq("website_id", q.websiteId).eq("session_id", q.sessionId).eq("operator_id", q.operatorId)
        .eq("kind", q.kind).eq("input_fp", q.inputFp).gt("created_at", since)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data as OutputRow | null;
    },
    async insertOutput(row) {
      const { data, error } = await sb.from("outputs").insert(row).select("id").single();
      if (error) throw error;
      return data.id as number;
    },
    async saveReviewTemplate(operatorId, websiteId, text) {
      const rows = await this.getProfiles(operatorId, websiteId);
      for (const row of rows) {
        const manual = { ...(row.manual_override ?? {}), review_template_manual: true } as Record<string, unknown>;
        const { error } = await sb.from("agent_profiles")
          .update({ review_template: text, review_template_suggestion: null, manual_override: manual })
          .eq("crisp_user_id", operatorId).eq("website_id", websiteId).eq("topic", row.topic);
        if (error) throw error;
      }
    },
    async addStyleSample(operatorId, websiteId, kind, text) {
      const { error } = await sb.from("profile_style_samples")
        .insert({ crisp_user_id: operatorId, website_id: websiteId, kind, text });
      if (error) throw error;
    },
    async getLatestDraft(websiteId, sessionId, operatorId) {
      const { data, error } = await sb.from("outputs").select(OUTPUT_COLUMNS)
        .eq("website_id", websiteId).eq("session_id", sessionId).eq("operator_id", operatorId).eq("kind", "draft")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data as OutputRow | null;
    },
    async setAiTopic(websiteId, sessionId, topic) {
      const { error } = await sb.from("conversations").update({ topic, topic_source: "ai" })
        .eq("website_id", websiteId).eq("session_id", sessionId).is("topic", null);
      if (error) throw error;
    },
    async matchHelpdesk(websiteId, embedding, k) {
      const { data, error } = await sb.rpc("match_helpdesk", { p_website_id: websiteId, p_embedding: JSON.stringify(embedding), p_k: k });
      if (error) throw error;
      return (data ?? []) as HelpdeskChunk[];
    },
    async hybridMatchHelpdesk(websiteId, query, embedding, k) {
      const { data, error } = await sb.rpc("hybrid_match_helpdesk", {
        p_website_id: websiteId, p_query: query, p_embedding: JSON.stringify(embedding), p_k: k,
      });
      if (error) throw error;
      type Row = { title: string; url: string; text: string; similarity: number; score: number; fts_rank: number | null };
      return ((data ?? []) as Row[]).map((r) => ({
        title: r.title, url: r.url, text: r.text, similarity: r.similarity, score: r.score, ftsRank: r.fts_rank,
      }));
    },
    async matchCases(websiteId, embedding, k) {
      const { data, error } = await sb.rpc("match_cases", { p_website_id: websiteId, p_embedding: JSON.stringify(embedding), p_k: k });
      if (error) throw error;
      return (data ?? []) as CaseMatch[];
    },
    async getJiraRows(websiteId, sessionId) {
      const { data: rawLinks, error } = await sb.from("jira_links")
        .select("website_id,session_id,issue_key,url,silent_baseline,last_seen_status,last_seen_comment_at,active")
        .eq("website_id", websiteId).eq("session_id", sessionId).order("created_at");
      if (error) throw error;
      // Chỉ link đang theo dõi (active) mới lên panel và vào ngữ cảnh prompt.
      // Link inactive = CS gỡ tay, hoặc ticket Done ĐÃ báo khách và jira-sync
      // dọn dẹp tắt theo dõi. Ticket Done CHƯA báo khách vẫn active và vẫn
      // được trả về — jiraForConversation quyết định ẩn/hiện theo mốc CS nhắn
      // khách (Done ≠ đã báo khách, xem _shared/jira.ts).
      const links = ((rawLinks ?? []) as (JiraLink & { active?: boolean })[]).filter((l) => l.active === true);
      if (!links.length) return [];
      const keys = links.map((l) => l.issue_key as string);
      const [{ data: issues, error: e1 }, { data: comments, error: e2 }] = await Promise.all([
        sb.from("jira_issues").select("issue_key,summary,status,status_category,assignee,updated_at,status_changed_at,prev_status,synced_at").in("issue_key", keys),
        sb.from("jira_comments").select("id,issue_key,author,role,body_text,created_at").in("issue_key", keys).order("created_at"),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      return (links as JiraLink[]).map((link) => {
        const i = (issues ?? []).find((x) => x.issue_key === link.issue_key);
        return {
          link,
          issue: i ? { ...(i as Omit<JiraIssue, "comments">), comments: ((comments ?? []) as (JiraComment & { issue_key: string })[]).filter((c) => c.issue_key === link.issue_key) } : null,
        };
      });
    },
    async mergeConversationCustomData(websiteId, sessionId, patch) {
      const { data, error } = await sb.from("conversations")
        .select("custom_data").eq("website_id", websiteId).eq("session_id", sessionId).maybeSingle();
      if (error) throw error;
      if (!data) return false; // chưa có dòng (ingest chưa tạo) — không tự tạo dòng ở đây
      const merged = { ...((data.custom_data as Record<string, unknown> | null) ?? {}), ...patch };
      const { error: e2 } = await sb.from("conversations")
        .update({ custom_data: merged }).eq("website_id", websiteId).eq("session_id", sessionId);
      if (e2) throw e2;
      return true;
    },
    async unlinkJira(websiteId, sessionId, issueKey) {
      // Chỉ tắt đúng dòng của chat này: website+session+key đều phải khớp,
      // không gỡ lan sang chat khác đang theo dõi cùng ticket.
      const { data, error } = await sb.from("jira_links").update({ active: false })
        .eq("website_id", websiteId).eq("session_id", sessionId).eq("issue_key", issueKey)
        .eq("active", true) // chỉ gỡ link ĐANG active — gỡ lần 2 phải trả false, không báo "đã gỡ" sai
        .select("issue_key");
      if (error) throw error;
      return (data ?? []).length > 0;
    },
    async getSentiment(websiteId, sessionId) {
      const { data, error } = await sb.from("conversation_sentiment")
        .select("score,mood,urgency,confidence,summary,signals,issues,input_fp")
        .eq("website_id", websiteId).eq("session_id", sessionId).maybeSingle();
      if (error) throw error;
      return data as (Sentiment & { input_fp: string }) | null;
    },
    async getStorefrontSeen(websiteId) {
      const { data, error } = await sb.from("storefront_seen").select("fingerprint").eq("website_id", websiteId);
      if (error) throw error;
      return (data ?? []).map((r) => r.fingerprint as string);
    },
    async markStorefrontSeen(websiteId, fingerprints) {
      if (!fingerprints.length) return;
      // Upsert chỉ kèm last_seen_at: dòng mới lấy first_seen_at từ default của
      // bảng, dòng cũ khi conflict chỉ cập nhật last_seen_at — mốc "lần đầu
      // hiện" không bị ghi đè.
      const rows = fingerprints.map((fingerprint) => ({ website_id: websiteId, fingerprint, last_seen_at: new Date().toISOString() }));
      const { error } = await sb.from("storefront_seen").upsert(rows, { onConflict: "website_id,fingerprint" });
      if (error) throw error;
    },
    async getStorefrontStoreStatus(websiteId, shop) {
      const { data, error } = await sb.from("storefront_store_status")
        .select("website_id,shop,watched,open_critical,open_high,open_medium,open_low,open_total,worst_severity,last_good_check,fetched_at")
        .eq("website_id", websiteId).eq("shop", shop).maybeSingle();
      if (error) throw error;
      return data as StorefrontStoreStatus | null;
    },
    async upsertStorefrontStoreStatus(row) {
      const { error } = await sb.from("storefront_store_status")
        .upsert(row, { onConflict: "website_id,shop" });
      if (error) throw error;
    },
    async getRecentShopDomains(websiteId, days) {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data, error } = await sb.from("conversations")
        .select("custom_data")
        .eq("website_id", websiteId).gte("updated_at", since)
        .not("custom_data", "is", null);
      if (error) throw error;
      // custom_data là dữ liệu phía khách ghi — trích shopify_domain ở đây và
      // chỉ giữ giá trị hợp lệ (isPlausibleShop) + duy nhất, giữ nguyên thứ tự
      // gặp đầu tiên để job sweep quét tất định.
      const out: string[] = [];
      const seen = new Set<string>();
      for (const r of data ?? []) {
        const cd = (r as { custom_data?: Record<string, unknown> | null }).custom_data;
        const v = cd?.shopify_domain;
        if (!isPlausibleShop(v)) continue;
        const shop = v.trim();
        if (seen.has(shop)) continue;
        seen.add(shop);
        out.push(shop);
      }
      return out;
    },
    async listStorefrontStoreStatus(websiteId) {
      const { data, error } = await sb.from("storefront_store_status")
        .select("website_id,shop,watched,open_critical,open_high,open_medium,open_low,open_total,worst_severity,last_good_check,fetched_at")
        .eq("website_id", websiteId);
      if (error) throw error;
      return (data ?? []) as StorefrontStoreStatus[];
    },
    async getDigestState(websiteId, shop) {
      const { data, error } = await sb.from("storefront_digest_state")
        .select("last_good_check")
        .eq("website_id", websiteId).eq("shop", shop).maybeSingle();
      if (error) throw error;
      return data as { last_good_check: string | null } | null;
    },
    async setDigestState(websiteId, shop, lastGoodCheck) {
      const { error } = await sb.from("storefront_digest_state")
        .upsert(
          { website_id: websiteId, shop, last_good_check: lastGoodCheck, updated_at: new Date().toISOString() },
          { onConflict: "website_id,shop" },
        );
      if (error) throw error;
    },
    async getDigestFindings(websiteId, shop) {
      const { data, error } = await sb.from("storefront_digest_findings")
        .select("fingerprint")
        .eq("website_id", websiteId).eq("shop", shop);
      if (error) throw error;
      return (data ?? []).map((r) => r.fingerprint as string);
    },
    async addDigestFindings(websiteId, shop, fingerprints) {
      if (!fingerprints.length) return;
      const rows = [...new Set(fingerprints)].map((fingerprint) => ({ website_id: websiteId, shop, fingerprint }));
      const { error } = await sb.from("storefront_digest_findings")
        .upsert(rows, { onConflict: "website_id,shop,fingerprint", ignoreDuplicates: true });
      if (error) throw error;
    },
    async getLatestSessionForShop(websiteId, shop) {
      // custom_data là dữ liệu phía khách ghi: lấy các conversation gần
      // nhất rồi khớp shopify_domain ở đây (cùng quy ước getRecentShopDomains)
      // thay vì đẩy toán tử JSON xuống PostgREST.
      const { data, error } = await sb.from("conversations")
        .select("session_id,custom_data,updated_at")
        .eq("website_id", websiteId)
        .not("custom_data", "is", null)
        .order("updated_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      for (const r of data ?? []) {
        const cd = (r as { custom_data?: Record<string, unknown> | null }).custom_data;
        const v = cd?.shopify_domain;
        if (isPlausibleShop(v) && v.trim() === shop) {
          return (r as { session_id: string }).session_id;
        }
      }
      return null;
    },
    async getStorefrontSegmentCandidates(websiteId, days) {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const cols = "session_id,custom_data,segments";
      // (a) conversation gần đây có domain — ứng viên GẮN; (b) mọi
      // conversation đang mang segment trong mirror — ứng viên GỠ khi store
      // hết điều kiện, không bị cửa sổ ngày chặn (segment treo trên chat cũ
      // vẫn phải được dọn).
      const [recent, tagged] = await Promise.all([
        sb.from("conversations").select(cols).eq("website_id", websiteId).gte("updated_at", since),
        sb.from("conversations").select(cols).eq("website_id", websiteId).contains("segments", [STOREFRONT_WATCH_SEGMENT]),
      ]);
      if (recent.error) throw recent.error;
      if (tagged.error) throw tagged.error;
      const bySession = new Map<string, StorefrontSegmentCandidate>();
      const add = (r: { session_id?: unknown; custom_data?: unknown; segments?: unknown }) => {
        const sessionId = typeof r.session_id === "string" ? r.session_id : "";
        if (!sessionId || bySession.has(sessionId)) return;
        const cd = (r.custom_data ?? null) as Record<string, unknown> | null;
        const v = cd?.shopify_domain;
        const segments = Array.isArray(r.segments) ? r.segments.filter((s): s is string => typeof s === "string") : [];
        const shop = isPlausibleShop(v) ? v.trim() : null;
        // Chỉ giữ dòng có ích cho việc đồng bộ: có shop để đối chiếu bản
        // chụp, hoặc đang mang segment của mình (cần gỡ). Dòng còn lại
        // không thể đổi trạng thái segment nào cả.
        if (shop === null && !segments.includes(STOREFRONT_WATCH_SEGMENT)) return;
        bySession.set(sessionId, { session_id: sessionId, shop, segments });
      };
      for (const r of recent.data ?? []) add(r as { session_id?: unknown; custom_data?: unknown; segments?: unknown });
      for (const r of tagged.data ?? []) add(r as { session_id?: unknown; custom_data?: unknown; segments?: unknown });
      return [...bySession.values()];
    },
    async getOperatorIdByEmail(email) {
      const { data, error } = await sb.from("operators")
        .select("crisp_user_id")
        .eq("email", email)
        .limit(1);
      if (error) throw error;
      return (data?.[0]?.crisp_user_id as string | undefined) ?? null;
    },
    async getReviewSend(websiteId, sessionId) {
      const { data, error } = await sb.from("outputs")
        .select("created_at")
        .eq("website_id", websiteId).eq("session_id", sessionId).eq("kind", "review")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      const at = data?.[0]?.created_at as string | undefined;
      return at ? { sent_at: at } : null;
    },
    async getCsatSend(websiteId, sessionId) {
      const { data, error } = await sb.from("csat_survey_sends")
        .select("sent_by,sent_at")
        .eq("website_id", websiteId).eq("session_id", sessionId).maybeSingle();
      if (error) throw error;
      return data as { sent_by: string; sent_at: string } | null;
    },
    async recordCsatSend(websiteId, sessionId, operatorId) {
      const { data, error } = await sb.from("csat_survey_sends")
        .upsert({ website_id: websiteId, session_id: sessionId, sent_by: operatorId }, { onConflict: "website_id,session_id", ignoreDuplicates: true })
        .select("sent_at").maybeSingle();
      if (error) throw error;
      return data as { sent_at: string } | null;
    },
    async releaseCsatSend(websiteId, sessionId) {
      const { error } = await sb.from("csat_survey_sends").delete()
        .eq("website_id", websiteId).eq("session_id", sessionId);
      if (error) throw error;
    },
    async saveSentiment(row) {
      const { error } = await sb.from("conversation_sentiment").upsert({ ...row, updated_at: new Date().toISOString() });
      if (error) throw error;
    },
    async appendSentimentHistory(row) {
      const { error } = await sb.from("sentiment_history").insert({
        website_id: row.website_id,
        session_id: row.session_id,
        input_fp: row.input_fp,
        score: row.score,
        mood: row.mood,
        urgency: row.urgency,
        confidence: row.confidence,
        summary: row.summary,
        signals: row.signals,
        issues: row.issues,
        model: row.model,
        source: row.source,
      });
      if (error) throw error;
    },
    async getSentimentHistory(websiteId, sessionId, limit) {
      const { data, error } = await sb.from("sentiment_history")
        .select("score,mood,urgency,confidence,summary,signals,issues,input_fp,source,created_at")
        .eq("website_id", websiteId).eq("session_id", sessionId)
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []) as (Sentiment & { input_fp: string; source: string; created_at: string })[];
    },
    async getVariants(task) {
      const { data, error } = await sb.from("prompt_variants").select("prompt_version,template_notes,weight").eq("task", task);
      if (error) throw error;
      return (data ?? []) as Variant[];
    },
  };
}

export function createAiStore(sb: SupabaseClient): AiStore {
  return {
    async getModels(task) {
      const { data, error } = await sb.from("ai_config").select("models").eq("task", task).maybeSingle();
      if (error) throw error;
      return (data?.models as string[] | undefined) ?? [];
    },
    async logUsage(model, task, is429) {
      const { error } = await sb.rpc("log_ai_usage", { p_model: model, p_task: task, p_is_429: is429 });
      if (error) throw error;
    },
  };
}

export function createHelpdeskStore(sb: SupabaseClient): HelpdeskStore {
  return {
    async pendingArticles(limit) {
      const { data, error } = await sb.from("helpdesk_pending_articles").select("id,title,content_md,content_hash")
        .order("id").limit(limit);
      if (error) throw error;
      return (data ?? []) as { id: number; title: string; content_md: string; content_hash: string }[];
    },
    async countPending() {
      const { count, error } = await sb.from("helpdesk_pending_articles").select("id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
    async replaceChunks(articlePk, hash, chunks) {
      const { error } = await sb.rpc("replace_helpdesk_chunks", {
        p_article_pk: articlePk,
        p_hash: hash,
        p_chunks: chunks.map((c) => ({ text: c.text, embedding: JSON.stringify(c.embedding) })),
      });
      if (error) throw error;
    },
  };
}

export function createJiraStore(sb: SupabaseClient): JiraStore {
  return {
    async csNames() {
      const [{ data: ops, error: e1 }, { data: ws, error: e2 }] = await Promise.all([
        sb.from("operators").select("display_name,jira_display_name"),
        sb.from("workspaces").select("cs_jira_authors"),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const names = new Set<string>();
      for (const o of ops ?? []) for (const n of [o.display_name, o.jira_display_name]) if (n) names.add(n as string);
      for (const w of ws ?? []) for (const n of (w.cs_jira_authors as string[] | null) ?? []) names.add(n);
      return [...names];
    },
    async saveIssue(issue) {
      const { data: prev, error: e0 } = await sb.from("jira_issues").select("status,status_changed_at,prev_status").eq("issue_key", issue.issue_key).maybeSingle();
      if (e0) throw e0;
      const changed = Boolean(prev && prev.status !== issue.status);
      // Đổi trạng thái: ghi mốc phát hiện đổi (status_changed_at) VÀ trạng thái
      // bị thay thế (prev_status) — panel cần cả hai để hiện "từ <cũ> → <mới>"
      // và để biết ticket chuyển Done từ khi nào. Không đổi thì giữ nguyên cả hai.
      const marks = {
        status_changed_at: changed ? new Date().toISOString() : prev?.status_changed_at ?? null,
        prev_status: changed ? (prev?.status ?? null) : prev?.prev_status ?? null,
      };
      const { error } = await sb.from("jira_issues").upsert({
        issue_key: issue.issue_key,
        summary: issue.summary,
        status: issue.status,
        status_category: issue.status_category,
        assignee: issue.assignee,
        updated_at: issue.updated_at,
        ...marks,
        synced_at: new Date().toISOString(),
      });
      if (error) throw error;
      if (issue.comments.length) {
        const { error: e2 } = await sb.from("jira_comments").upsert(issue.comments.map((c) => ({ ...c, issue_key: issue.issue_key })));
        if (e2) throw e2;
      }
      return marks;
    },
    async linksFor(keys) {
      // Panel-only mirror: link không kèm cờ đăng note nào nữa — sync không bao giờ ghi lên Crisp.
      const { data, error } = await sb.from("jira_links")
        .select("website_id,session_id,issue_key,url,silent_baseline,last_seen_status,last_seen_comment_at").eq("active", true).in("issue_key", keys);
      if (error) throw error;
      return (data ?? []) as JiraLink[];
    },
    async updateLink(link, patch) {
      const { error } = await sb.from("jira_links").update(patch)
        .eq("website_id", link.website_id).eq("session_id", link.session_id).eq("issue_key", link.issue_key);
      if (error) throw error;
    },
    async lastHumanOperatorAt(link) {
      const { data, error } = await sb.from("conversations").select("last_human_operator_at")
        .eq("website_id", link.website_id).eq("session_id", link.session_id).maybeSingle();
      if (error) throw error;
      return (data?.last_human_operator_at as string | undefined) ?? null;
    },
  };
}
