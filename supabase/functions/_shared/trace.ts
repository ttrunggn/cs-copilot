import type { Db, TraceRow } from "./db.ts";
import type { AiTraceEvent } from "./openai.ts";

export type { TraceRow };

/**
 * Cầu nối tracing cho client AI: mỗi lần thử gọi API thành một dòng trace_log
 * (action = tác vụ, stage = model, detail chứa attempt/keyIndex/status/token).
 * Sự kiện mang error ghi kind "error", còn lại kind "timing".
 */
export function aiTraceSink(db: Db): (e: AiTraceEvent) => Promise<void> {
  return (e) =>
    writeTrace(db, {
      action: e.task,
      kind: e.error ? "error" : "timing",
      stage: e.model,
      duration_ms: e.durationMs,
      message: e.error ?? null,
      detail: {
        provider: "openai",
        attempt: e.attempt,
        key_index: e.keyIndex,
        status: e.status,
        ...(e.promptTokens != null ? { prompt_tokens: e.promptTokens } : {}),
        ...(e.completionTokens != null ? { completion_tokens: e.completionTokens } : {}),
        ...(e.totalTokens != null ? { total_tokens: e.totalTokens } : {}),
      },
    });
}

/**
 * Ghi một dòng truy vết (tracing) vào bảng trace_log (migration 028).
 * NGUYÊN TẮC CỨNG: tracing không bao giờ làm gãy nghiệp vụ — bảng chưa có
 * (chưa chạy migration), DB lỗi, hay bất cứ trục trặc nào đều bị nuốt tại
 * đây. Ethan chốt 2026-10-26: mọi việc đều cần truy vết được.
 */
export async function writeTrace(db: Db | undefined | null, row: TraceRow): Promise<void> {
  try {
    await db?.logTrace(row);
  } catch {
    // cố ý nuốt: xem nguyên tắc ở trên
  }
}

/**
 * Đưa một promise chạy nền vào EdgeRuntime.waitUntil để Edge Function
 * không bị đóng trước khi việc nền xong (Supabase). Ngoài môi trường Edge
 * (test/local) thì cứ để promise tự chạy.
 */
export function waitUntilBg(p: Promise<unknown>): void {
  try {
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(p);
    else void p;
  } catch {
    void p;
  }
}
