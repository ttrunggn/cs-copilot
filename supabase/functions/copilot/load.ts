import { HttpError } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";
import type { ConversationRow, MessageRow } from "../_shared/types.ts";

export const MESSAGE_LIMIT = 60;
// Webhook ingest đã đẩy tin mới vào DB gần như tức thì, nên bản ghi mới cập nhật
// trong khoảng này coi như tươi: khỏi refresh qua n8n (vốn mất ~3-5s mỗi lần).
export const FRESH_MS = 60_000;

export interface LoadDeps {
  db: Db;
  n8n: N8n;
  /** Chạy việc nền sau khi đã trả response (EdgeRuntime.waitUntil ở index.ts). */
  background?: (task: Promise<unknown>) => void;
  now?: () => number;
}

type Loaded = { stale: boolean; conv: ConversationRow; messages: MessageRow[] };

/**
 * Bước chung của generate/handoff: cần dữ liệu mới nhất, nhưng webhook ingest
 * đã giữ DB gần như tức thì — bản ghi còn tươi (≤ FRESH_MS, ví dụ panel vừa
 * check xong) thì khỏi refresh đồng bộ qua n8n, tiết kiệm ~3-5s mỗi lần soạn.
 * Bản ghi đã cũ hoặc chưa có thì vẫn refresh qua n8n như cũ rồi mới đọc.
 */
export async function loadConversation(
  deps: LoadDeps,
  websiteId: string,
  sessionId: string,
): Promise<Loaded> {
  const existing = await deps.db.getConversation(websiteId, sessionId).catch(() => null);
  if (existing) {
    const now = (deps.now ?? Date.now)();
    const age = existing.updated_at ? now - Date.parse(existing.updated_at) : Number.POSITIVE_INFINITY;
    if (age <= FRESH_MS) {
      const messages = await deps.db.getMessages(websiteId, sessionId, MESSAGE_LIMIT);
      return { stale: false, conv: existing, messages };
    }
  }
  const { stale } = await deps.n8n.refreshConversation(websiteId, sessionId);
  const conv = await deps.db.getConversation(websiteId, sessionId);
  if (!conv) throw new HttpError(404, "Chưa có dữ liệu conversation này");
  const messages = await deps.db.getMessages(websiteId, sessionId, MESSAGE_LIMIT);
  return { stale, conv, messages };
}

/**
 * Đường nhanh cho `check` (chỉ đọc): trả ngay dữ liệu đang có trong DB, refresh
 * Crisp chạy nền để lần mở sau đã mới — thay vì bắt CS chờ n8n mỗi lần mở panel.
 * Chưa có bản ghi nào (conversation mới tinh) thì vẫn refresh đồng bộ như cũ.
 */
export async function loadConversationFast(
  deps: LoadDeps,
  websiteId: string,
  sessionId: string,
): Promise<Loaded> {
  const conv = await deps.db.getConversation(websiteId, sessionId);
  if (!conv) return loadConversation(deps, websiteId, sessionId);
  const now = (deps.now ?? Date.now)();
  const parsedAge = conv.updated_at ? now - Date.parse(conv.updated_at) : Number.POSITIVE_INFINITY;
  // updated_at không parse được (NaN) → coi như cũ hẳn để refresh, khớp hướng
  // xử lý của loadConversation — trước đây NaN làm cả hai phép so đều false,
  // dữ liệu bị kẹt ở trạng thái "tươi giả" không bao giờ refresh.
  const age = Number.isNaN(parsedAge) ? Number.POSITIVE_INFINITY : parsedAge;
  let stale = false;
  if (age > FRESH_MS) {
    const refresh = deps.n8n.refreshConversation(websiteId, sessionId).catch(() => ({ stale: true }));
    if (deps.background) {
      // Có đường nền: trả ngay, dữ liệu có thể cũ tới lần mở sau.
      stale = true;
      deps.background(refresh);
    } else {
      // Không có đường nền (test/cục bộ): chờ refresh như cũ và dùng cờ của nó.
      stale = (await refresh).stale;
    }
  }
  const messages = await deps.db.getMessages(websiteId, sessionId, MESSAGE_LIMIT);
  return { stale, conv, messages };
}
