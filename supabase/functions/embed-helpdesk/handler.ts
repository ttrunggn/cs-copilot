import { chunkMarkdown } from "../_shared/chunk.ts";
import type { Ai } from "../_shared/gemini.ts";

export interface HelpdeskStore {
  pendingArticles(limit: number): Promise<{ id: number; title: string; content_md: string; content_hash: string }[]>;
  countPending(): Promise<number>;
  replaceChunks(articlePk: number, hash: string, chunks: { text: string; embedding: number[] }[]): Promise<void>;
}

const DEFAULT_BATCH = 20;

/** So sánh không phụ thuộc vị trí ký tự sai. Secret placeholder hoặc < 32 ký tự thì luôn từ chối. */
function secretOk(got: string, secret: string): boolean {
  if (secret.startsWith("REPLACE_") || secret.length < 32) return false;
  let diff = got.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
  return diff === 0;
}

/** Embed các bài helpdesk đã đổi nội dung (embedded_hash ≠ content_hash). n8n gọi sau mỗi lần đồng bộ. */
export async function handleEmbed(
  secretHeader: string,
  deps: { store: HelpdeskStore; ai: Ai; secret: string; batch?: number },
): Promise<{ status: number; body: { embedded: number; remaining: number } | { error: string } }> {
  if (!secretOk(secretHeader, deps.secret)) return { status: 401, body: { error: "unauthorized" } };
  let embedded = 0;
  for (const a of await deps.store.pendingArticles(deps.batch ?? DEFAULT_BATCH)) {
    try {
      const texts = chunkMarkdown(a.title, a.content_md);
      const vectors = texts.length ? await deps.ai.embed(texts, "document") : [];
      await deps.store.replaceChunks(a.id, a.content_hash, texts.map((text, i) => ({ text, embedding: vectors[i] })));
      embedded++;
    } catch (e) {
      // Bài lỗi giữ nguyên trạng thái chờ, lần gọi sau thử lại.
      console.error(`embed article ${a.id} failed`, e);
    }
  }
  return { status: 200, body: { embedded, remaining: await deps.store.countPending() } };
}
