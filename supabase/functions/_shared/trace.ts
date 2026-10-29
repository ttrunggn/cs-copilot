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
 * Mã lỗi chuẩn hoá cho mọi luồng (khung truy vết, migration 032 — Ethan chốt
 * 2026-10-29: panel gộp phải trace được cả luồng lỗi lẫn luồng vận hành thật).
 * Panel chỉ hiện 1 câu trạng thái cho CS; mã này + flow_id là thứ CS chụp gửi
 * để tra cứu ngược trong trace_log.
 */
export const TRACE_ERROR_CODES = ["AUTH", "DATA", "AI", "UPSTREAM", "CLIENT", "UNKNOWN"] as const;
export type TraceErrorCode = (typeof TRACE_ERROR_CODES)[number];

/** Sinh mã luồng duy nhất cho một lượt vận hành: `<action>-<thời gian>-<ngẫu nhiên>`. */
export function newFlowId(action: string): string {
  const rand = crypto.randomUUID().slice(0, 8);
  return `${action}-${Date.now().toString(36)}-${rand}`;
}

/**
 * Bộ ghi vết theo luồng: tạo một lần cho mỗi lượt vận hành (request, hook,
 * lượt mở modal), mọi stage ghi qua đây đều mang cùng flow_id + website_id +
 * session_id + action. timing() cho các chặng chạy thật, error() cho lỗi kèm
 * mã chuẩn hoá. Mọi ghi đều đi qua writeTrace nên hỏng tracing không gãy luồng.
 */
export class FlowTracer {
  readonly flowId: string;
  constructor(
    private db: Db | undefined | null,
    private ctx: { website_id?: string | null; session_id?: string | null; action: string; flowId?: string },
  ) {
    this.flowId = ctx.flowId ?? newFlowId(ctx.action);
  }
  async timing(stage: string, durationMs?: number, detail?: Record<string, unknown>): Promise<void> {
    await writeTrace(this.db, {
      website_id: this.ctx.website_id ?? null,
      session_id: this.ctx.session_id ?? null,
      action: this.ctx.action,
      kind: "timing",
      stage,
      duration_ms: durationMs != null ? Math.round(durationMs) : null,
      detail: detail ?? null,
      flow_id: this.flowId,
    });
  }
  async error(stage: string, code: TraceErrorCode, message: string, detail?: Record<string, unknown>): Promise<void> {
    await writeTrace(this.db, {
      website_id: this.ctx.website_id ?? null,
      session_id: this.ctx.session_id ?? null,
      action: this.ctx.action,
      kind: "error",
      stage,
      message,
      detail: { ...(detail ?? {}), error_code: code },
      flow_id: this.flowId,
    });
  }
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
