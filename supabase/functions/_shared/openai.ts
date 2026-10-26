import { AiUnavailable, type Ai, type AiStore, type AiTask } from "./gemini.ts";

/**
 * Client OpenAI đứng sau cùng interface Ai như Gemini (Ethan chốt chuyển nhà 2026-10-27).
 * - Sinh text qua Chat Completions, model lấy từ ai_config (gpt-6-luna).
 * - reasoning_effort GHIM "none": Luna mặc định "medium" mà bản reasoning có
 *   thời gian tới token đầu 15-26 giây (đo bên thứ ba) — đúng bệnh chậm phải tránh;
 *   "none" cũng là điều kiện để temperature được áp (vd lượt viết lại 1.2).
 * - Embed qua text-embedding-3-small với dimensions=768 để giữ nguyên cột vector(768);
 *   vector của nhà cung cấp khác KHÔNG trộn được với vector Gemini đã lưu —
 *   sau khi chuyển phải chạy scripts/reembed-openai.ts nhúng lại toàn bộ.
 */

const BASE = "https://api.openai.com/v1";
const EMBED_BATCH = 100;
const EMBED_DIM = 768;

const TYPE_MAP: Record<string, string> = {
  OBJECT: "object",
  ARRAY: "array",
  STRING: "string",
  INTEGER: "integer",
  NUMBER: "number",
  BOOLEAN: "boolean",
};

/**
 * Chuẩn hoá schema kiểu Gemini (type viết HOA, có thể lẫn kiểu JSON thường)
 * thành JSON Schema cho OpenAI. Chỉ giữ các khoá OpenAI hiểu; đệ quy vào
 * properties/items. Dùng với strict=false nên không ép required=toàn bộ thuộc tính.
 */
export function toOpenAiJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toOpenAiJsonSchema);
  if (!node || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof src.type === "string") out.type = TYPE_MAP[src.type.toUpperCase()] ?? src.type.toLowerCase();
  if (src.properties && typeof src.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src.properties as Record<string, unknown>)) props[k] = toOpenAiJsonSchema(v);
    out.properties = props;
  }
  if (src.items !== undefined) out.items = toOpenAiJsonSchema(src.items);
  if (Array.isArray(src.required)) out.required = src.required;
  if (Array.isArray(src.enum)) out.enum = src.enum;
  if (typeof src.description === "string") out.description = src.description;
  return out;
}

/**
 * Sự kiện truy vết cho MỘT lần thử gọi API (mỗi model × key là một lần thử).
 * Gồm cả token usage ở lần thử thành công — đây là nguồn số liệu cost thật.
 * keyIndex là vị trí key trong danh sách cấu hình, KHÔNG bao giờ ghi giá trị key.
 */
export interface AiTraceEvent {
  task: AiTask;
  model: string;
  attempt: number;
  keyIndex: number;
  status: number | "network_error";
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Có ở sự kiện cuối khi cả lượt gọi thất bại. */
  error?: string;
}

/** Key sai/bị thu hồi: thử key kế tiếp (đổi model không giúp được). */
function badKey(status: number): boolean {
  return status === 401 || status === 403;
}

/** Lỗi đáng thử model kế tiếp: model không tồn tại, lỗi phía OpenAI. */
function retryable(status: number): boolean {
  return status === 404 || status >= 500;
}

/** Nhiều API key: key hết quota (429) hoặc sai → key kế tiếp; key vừa chạy được thử trước ở lần sau. */
export function createOpenAi(opts: { apiKeys: string[]; store: AiStore; fetch?: typeof fetch; trace?: (e: AiTraceEvent) => void | Promise<void> }): Ai {
  const doFetch = opts.fetch ?? fetch;
  const keys = opts.apiKeys.filter((k) => k.trim());
  if (!keys.length) throw new Error("Thiếu OpenAI API key");
  let preferred = 0;

  async function log(model: string, task: AiTask, is429: boolean) {
    try {
      await opts.store.logUsage(model, task, is429);
    } catch (e) {
      console.error("ai usage log failed", e);
    }
  }

  /** Tracing không bao giờ làm gãy nghiệp vụ: nuốt mọi lỗi của sink. */
  async function emit(e: AiTraceEvent) {
    try {
      await opts.trace?.(e);
    } catch {
      // cố ý nuốt
    }
  }

  /**
   * Thử lần lượt từng model của task. Trong một model: 429 hoặc key sai → key kế tiếp; 404/5xx/lỗi mạng → model kế tiếp.
   * Mọi lần thử đều phát sự kiện tracing kèm thời lượng; lần thành công kèm token usage.
   * Trả JSON response đầu tiên thành công.
   */
  async function call(task: AiTask, path: string, body: (model: string) => unknown): Promise<{ json: any; model: string }> {
    let attempt = 0;
    let last: { model: string; keyIndex: number; status: number | "network_error" } | null = null;
    for (const model of await opts.store.getModels(task)) {
      for (let n = 0; n < keys.length; n++) {
        const k = (preferred + n) % keys.length;
        attempt++;
        const started = performance.now();
        let res: Response;
        try {
          res = await doFetch(`${BASE}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${keys[k]}` },
            body: JSON.stringify(body(model)),
          });
        } catch {
          await log(model, task, false);
          last = { model, keyIndex: k, status: "network_error" };
          await emit({ task, model, attempt, keyIndex: k, status: "network_error", durationMs: Math.round(performance.now() - started) });
          break;
        }
        await log(model, task, res.status === 429);
        if (res.ok) {
          preferred = k;
          const json = await res.json();
          const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } })?.usage;
          await emit({
            task,
            model,
            attempt,
            keyIndex: k,
            status: res.status,
            durationMs: Math.round(performance.now() - started),
            ...(usage?.prompt_tokens != null ? { promptTokens: usage.prompt_tokens } : {}),
            ...(usage?.completion_tokens != null ? { completionTokens: usage.completion_tokens } : {}),
            ...(usage?.total_tokens != null ? { totalTokens: usage.total_tokens } : {}),
          });
          return { json, model };
        }
        const detail = await res.text().catch(() => "");
        last = { model, keyIndex: k, status: res.status };
        await emit({ task, model, attempt, keyIndex: k, status: res.status, durationMs: Math.round(performance.now() - started) });
        if (res.status === 429 || badKey(res.status)) continue;
        if (!retryable(res.status)) {
          const err = new Error(`OpenAI ${model} ${res.status}: ${detail.slice(0, 300)}`);
          await emit({ task, model, attempt, keyIndex: k, status: res.status, durationMs: 0, error: err.message });
          throw err;
        }
        break;
      }
    }
    const err = new AiUnavailable();
    if (last) await emit({ task, model: last.model, attempt, keyIndex: last.keyIndex, status: last.status, durationMs: 0, error: err.message });
    throw err;
  }

  return {
    async generate(task, prompt, o = {}) {
      const { json, model } = await call(task, "/chat/completions", (model) => ({
        model,
        messages: [{ role: "user", content: prompt }],
        reasoning_effort: "none",
        ...(o.temperature != null ? { temperature: o.temperature } : {}),
        ...(o.schema
          ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "response", strict: false, schema: toOpenAiJsonSchema(o.schema) },
            },
          }
          : {}),
      }));
      const content = json?.choices?.[0]?.message?.content;
      return { text: typeof content === "string" ? content : "", model };
    },

    async embed(texts, _kind) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        const { json } = await call("embed", "/embeddings", (model) => ({
          model,
          input: batch,
          dimensions: EMBED_DIM,
        }));
        const data: { index: number; embedding: number[] }[] = [...(json?.data ?? [])].sort((a, b) => a.index - b.index);
        if (data.length !== batch.length) throw new Error("OpenAI embed trả thiếu vector");
        for (const d of data) {
          if (!Array.isArray(d.embedding) || d.embedding.length !== EMBED_DIM) {
            throw new Error(`OpenAI embed trả vector sai số chiều (cần ${EMBED_DIM})`);
          }
        }
        out.push(...data.map((d) => d.embedding));
      }
      return out;
    },
  };
}
