import type { ConversationRow, MessageRow, ProfileRow, Workspace } from "./types.ts";

export interface Db {
  getWorkspace(websiteId: string): Promise<Workspace | null>;
  getOperatorIdByTokenHash(tokenHash: string): Promise<string | null>;
  isOperatorMember(operatorId: string, websiteId: string): Promise<boolean>;
  getConversation(websiteId: string, sessionId: string): Promise<ConversationRow | null>;
  getMessages(websiteId: string, sessionId: string, limit: number): Promise<MessageRow[]>;
  getProfiles(operatorId: string, websiteId: string): Promise<ProfileRow[]>;
  getOperator(operatorId: string): Promise<{ display_name: string | null } | null>;
}
