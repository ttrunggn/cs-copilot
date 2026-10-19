import { HttpError } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";
import type { ConversationRow, MessageRow } from "../_shared/types.ts";

export const MESSAGE_LIMIT = 60;

/** Bước chung của mọi action: refresh qua n8n (quá hạn thì stale) rồi đọc conversation + tin nhắn từ DB. */
export async function loadConversation(
  deps: { db: Db; n8n: N8n },
  websiteId: string,
  sessionId: string,
): Promise<{ stale: boolean; conv: ConversationRow; messages: MessageRow[] }> {
  const { stale } = await deps.n8n.refreshConversation(websiteId, sessionId);
  const conv = await deps.db.getConversation(websiteId, sessionId);
  if (!conv) throw new HttpError(404, "Chưa có dữ liệu conversation này");
  const messages = await deps.db.getMessages(websiteId, sessionId, MESSAGE_LIMIT);
  return { stale, conv, messages };
}
