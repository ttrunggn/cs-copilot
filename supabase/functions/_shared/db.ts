import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AiStore } from "./gemini.ts";
import type { ConversationRow, MessageRow, NewOutput, OutputRow, ProfileRow, Workspace } from "./types.ts";

const OUTPUT_COLUMNS = "id,kind,content,warnings,verified,helpdesk_matches,topic,prompt_version,created_at";
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
        .select("website_id,session_id,customer_email,customer_name,topic,topic_source,state,last_customer_at,last_human_operator_at")
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
