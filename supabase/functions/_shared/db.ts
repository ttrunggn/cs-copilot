import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ConversationRow, MessageRow, ProfileRow, Workspace } from "./types.ts";

export interface Db {
  getWorkspace(websiteId: string): Promise<Workspace | null>;
  getWidgetTokenHash(websiteId: string): Promise<string | null>;
  getOperatorIdByTokenHash(tokenHash: string): Promise<string | null>;
  isOperatorMember(operatorId: string, websiteId: string): Promise<boolean>;
  getConversation(websiteId: string, sessionId: string): Promise<ConversationRow | null>;
  getMessages(websiteId: string, sessionId: string, limit: number): Promise<MessageRow[]>;
  getProfiles(operatorId: string, websiteId: string): Promise<ProfileRow[]>;
  getOperator(operatorId: string): Promise<{ display_name: string | null } | null>;
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
        .select("from,type,is_bot,content,created_at,operator_name")
        .eq("website_id", websiteId).eq("session_id", sessionId)
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return ((data ?? []) as MessageRow[]).reverse();
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
  };
}
