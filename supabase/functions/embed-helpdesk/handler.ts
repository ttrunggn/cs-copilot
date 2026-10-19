import { chunkMarkdown } from "../_shared/chunk.ts";
import type { Ai } from "../_shared/gemini.ts";

export interface HelpdeskStore {
  pendingArticles(limit: number): Promise<{ id: number; title: string; content_md: string; content_hash: string }[]>;
  countPending(): Promise<number>;
  replaceChunks(articlePk: number, hash: string, chunks: { text: string; embedding: number[] }[]): Promise<void>;
}

const DEFAULT_BATCH = 20;
// Edge Function free tier dừng ở ~150s; chừa thời gian cho countPending và response.
const DEFAULT_BUDGET_MS = 90_000;

/** So sánh không phụ thuộc vị trí ký tự sai. Secret placeholder hoặc < 32 ký tự thì luôn từ chối. */
function secretOk(got: string, secret: string): boolean {
  if (secret.startsWith("REPLACE_") || secret.length < 32) return false;
  let diff = got.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Embed các bài helpdesk đã đổi nội dung (embedded_hash ≠ content_hash). n8n gọi sau mỗi lần đồng bộ và mỗi đêm.
 * Chạy nhiều lô tới khi hết bài hoặc hết thời gian (Edge Function có giới hạn thời gian chạy).
 * Bài lỗi được bỏ qua trong lần gọi này để không chặn các bài phía sau; lần gọi sau thử lại.
 */
export async function handleEmbed(
  secretHeader: string,
  deps: { store: HelpdeskStore; ai: Ai; secret: string; batch?: number; budgetMs?: number; now?: () => number },
): Promise<{ status: number; body: { embedded: number; remaining: number } | { error: string } }> {
  if (!secretOk(secretHeader, deps.secret)) return { status: 401, body: { error: "unauthorized" } };
  const now = deps.now ?? Date.now;
  const batch = deps.batch ?? DEFAULT_BATCH;
  const budget = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const start = now();
  const seen = new Set<number>();
  let embedded = 0;
  while (now() - start < budget) {
    const fresh = (await deps.store.pendingArticles(batch + seen.size)).filter((a) => !seen.has(a.id)).slice(0, batch);
    if (!fresh.length) break;
    for (const a of fresh) {
      seen.add(a.id);
      try {
        const texts = chunkMarkdown(a.title, a.content_md);
        const vectors = texts.length ? await deps.ai.embed(texts, "document") : [];
        await deps.store.replaceChunks(a.id, a.content_hash, texts.map((text, i) => ({ text, embedding: vectors[i] })));
        embedded++;
      } catch (e) {
        console.error(`embed article ${a.id} failed`, e);
      }
    }
  }
  return { status: 200, body: { embedded, remaining: await deps.store.countPending() } };
}
