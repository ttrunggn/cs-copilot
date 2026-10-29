import type { Db } from "../_shared/db.ts";
import type { Ai } from "../_shared/gemini.ts";
import { resolveSentiment } from "./analyze.ts";
import { MESSAGE_LIMIT } from "./load.ts";

/**
 * Tính TRƯỚC sentiment ngay khi tin khách mới được ingest vào DB (n8n gọi sau
 * node Ingest Event), để panel mở conversation là có sẵn dữ liệu — real-time
 * lúc CS click vào khách thay vì chờ AI phân tích tại thời điểm mở.
 *
 * Route nội bộ trong chính function copilot (index.ts chặn bằng credential
 * nội bộ trước khi vào handle), KHÔNG qua auth operator: người gọi là n8n.
 * Best-effort tuyệt đối: lỗi mềm trả 200 kèm cờ `skipped`, để luồng ingest
 * không bao giờ gãy vì sentiment. Dấu vân tay trong resolveSentiment khiến
 * lần gọi lặp (tin chưa đổi) chỉ tốn 2 lượt đọc DB, không gọi AI.
 */
export async function runPrecompute(
  deps: { db: Db; ai: Ai },
  websiteId: string,
  sessionId: string,
): Promise<{ sentiment: boolean; cached: boolean; skipped: string | null }> {
  const ws = await deps.db.getWorkspace(websiteId).catch(() => null);
  if (!ws) return { sentiment: false, cached: false, skipped: "unknown_workspace" };
  const messages = await deps.db.getMessages(websiteId, sessionId, MESSAGE_LIMIT).catch(() => []);
  if (!messages.length) return { sentiment: false, cached: false, skipped: "no_messages" };
  const r = await resolveSentiment(deps, websiteId, sessionId, messages, false, "precompute");
  return { sentiment: Boolean(r.sentiment), cached: r.cached, skipped: r.sentiment ? null : (r.reason ?? "no_sentiment") };
}

export async function handlePrecompute(
  body: unknown,
  deps: { db: Db; ai: Ai },
): Promise<{ status: number; body: unknown }> {
  const b = (typeof body === "object" && body !== null) ? body as Record<string, unknown> : {};
  const websiteId = typeof b.website_id === "string" ? b.website_id : "";
  const sessionId = typeof b.session_id === "string" ? b.session_id : "";
  if (!websiteId || !sessionId) return { status: 400, body: { error: "Thiếu website_id/session_id" } };
  try {
    const r = await runPrecompute(deps, websiteId, sessionId);
    return { status: 200, body: { action: "precompute_sentiment", ...r } };
  } catch (e) {
    console.error("precompute failed", e);
    return { status: 200, body: { action: "precompute_sentiment", sentiment: false, cached: false, skipped: "error" } };
  }
}
