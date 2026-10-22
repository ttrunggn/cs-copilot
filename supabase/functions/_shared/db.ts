import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AiStore } from "./gemini.ts";
import type { HelpdeskStore } from "../embed-helpdesk/handler.ts";
import type { JiraStore, TrackedLink } from "../jira-sync/handler.ts";
import type { JiraComment, JiraIssue, JiraLink } from "./jira.ts";
import type { CaseMatch, ConversationRow, HelpdeskChunk, MessageRow, NewOutput, OutputRow, ProfileRow, Variant, Workspace } from "./types.ts";
import type { Sentiment } from "./sentiment.ts";

const OUTPUT_COLUMNS = "id,kind,content,warnings,verified,helpdesk_matches,topic,prompt_version,posted,created_at";
const CACHE_HOURS = 24;

export interface Db {
  getWorkspace(websiteId: string): Promise<Workspace | null>;
  getWidgetTokenHash(websiteId: string): Promise<string | null>;
  getOperatorIdByTokenHash(tokenHash: string): Promise<string | null>;
  isOperatorMember(operatorId: string, websiteId: string): Promise<boolean>;
  getConversation(websiteId: string, sessionId: string): Promise<ConversationRow | null>;
  getMessages(websiteId: string, sessionId: string, limit: number): Promise<MessageRow[]>;
  saveTranslations(rows: { id: number; content_en: string }[]): Promise<void>;
  getProfiles(operatorId: string, websiteId: string): Promise<ProfileRow[]>;
  getOperator(operatorId: string): Promise<{ display_name: string | null } | null>;
  findCachedOutput(q: { websiteId: string; sessionId: string; operatorId: string; kind: "draft" | "handoff"; inputFp: string }): Promise<OutputRow | null>;
  insertOutput(row: NewOutput): Promise<number>;
  markPosted(outputId: number, posted: boolean): Promise<void>;
  getLatestDraft(websiteId: string, sessionId: string, operatorId: string): Promise<OutputRow | null>;
  setAiTopic(websiteId: string, sessionId: string, topic: string): Promise<void>;
  matchHelpdesk(websiteId: string, embedding: number[], k: number): Promise<HelpdeskChunk[]>;
  matchCases(websiteId: string, embedding: number[], k: number): Promise<CaseMatch[]>;
  getVariants(task: "draft"): Promise<Variant[]>;
  getJiraRows(websiteId: string, sessionId: string): Promise<{ link: JiraLink; issue: JiraIssue | null }[]>;
  getSentiment(websiteId: string, sessionId: string): Promise<(Sentiment & { input_fp: string }) | null>;
  saveSentiment(row: Sentiment & { website_id: string; session_id: string; input_fp: string; model: string | null }): Promise<void>;
  getCsatSend(websiteId: string, sessionId: string): Promise<{ sent_by: string; sent_at: string } | null>;
  recordCsatSend(websiteId: string, sessionId: string, operatorId: string): Promise<{ sent_at: string } | null>;
}

export function createDb(sb: SupabaseClient): Db {
  return {
    async getWorkspace(websiteId) {
      const { data, error } = await sb.from("workspaces")
        .select("website_id,name,topics,default_profile")
        .eq("website_id", websiteId).maybeSingle();
      if (error) throw error;
      return data as Workspace | null;
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
        .select("website_id,session_id,customer_email,customer_name,topic,topic_source,state,last_customer_at,last_human_operator_at,updated_at")
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
    async markPosted(outputId, posted) {
      const { error } = await sb.from("outputs").update({ posted }).eq("id", outputId);
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
    async matchCases(websiteId, embedding, k) {
      const { data, error } = await sb.rpc("match_cases", { p_website_id: websiteId, p_embedding: JSON.stringify(embedding), p_k: k });
      if (error) throw error;
      return (data ?? []) as CaseMatch[];
    },
    async getJiraRows(websiteId, sessionId) {
      const { data: links, error } = await sb.from("jira_links")
        .select("website_id,session_id,issue_key,url,silent_baseline,last_seen_status,last_seen_comment_at")
        .eq("website_id", websiteId).eq("session_id", sessionId).order("created_at");
      if (error) throw error;
      if (!links?.length) return [];
      const keys = links.map((l) => l.issue_key as string);
      const [{ data: issues, error: e1 }, { data: comments, error: e2 }] = await Promise.all([
        sb.from("jira_issues").select("issue_key,summary,status,status_category,assignee,updated_at,status_changed_at").in("issue_key", keys),
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
    async getSentiment(websiteId, sessionId) {
      const { data, error } = await sb.from("conversation_sentiment")
        .select("score,mood,urgency,confidence,summary,signals,input_fp")
        .eq("website_id", websiteId).eq("session_id", sessionId).maybeSingle();
      if (error) throw error;
      return data as (Sentiment & { input_fp: string }) | null;
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
    async saveSentiment(row) {
      const { error } = await sb.from("conversation_sentiment").upsert({ ...row, updated_at: new Date().toISOString() });
      if (error) throw error;
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
      const { data: prev, error: e0 } = await sb.from("jira_issues").select("status,status_changed_at").eq("issue_key", issue.issue_key).maybeSingle();
      if (e0) throw e0;
      const changed = prev && prev.status !== issue.status;
      const { error } = await sb.from("jira_issues").upsert({
        issue_key: issue.issue_key,
        summary: issue.summary,
        status: issue.status,
        status_category: issue.status_category,
        assignee: issue.assignee,
        updated_at: issue.updated_at,
        status_changed_at: changed ? new Date().toISOString() : prev?.status_changed_at ?? null,
        synced_at: new Date().toISOString(),
      });
      if (error) throw error;
      if (issue.comments.length) {
        const { error: e2 } = await sb.from("jira_comments").upsert(issue.comments.map((c) => ({ ...c, issue_key: issue.issue_key })));
        if (e2) throw e2;
      }
    },
    async linksFor(keys) {
      const { data, error } = await sb.from("jira_links")
        .select("website_id,session_id,issue_key,url,silent_baseline,last_seen_status,last_seen_comment_at").eq("active", true).in("issue_key", keys);
      if (error) throw error;
      const { data: ws, error: e2 } = await sb.from("workspaces").select("website_id,jira_auto_note");
      if (e2) throw e2;
      const auto = new Map((ws ?? []).map((w) => [w.website_id as string, w.jira_auto_note as boolean]));
      return ((data ?? []) as JiraLink[]).map((l): TrackedLink => ({ ...l, auto_note: auto.get(l.website_id) ?? true }));
    },
    async updateLink(link, patch) {
      const { error } = await sb.from("jira_links").update(patch)
        .eq("website_id", link.website_id).eq("session_id", link.session_id).eq("issue_key", link.issue_key);
      if (error) throw error;
    },
  };
}
