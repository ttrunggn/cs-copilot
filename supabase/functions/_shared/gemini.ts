export type AiTask = "draft" | "verify" | "handoff" | "classify" | "translate" | "learn" | "case_summary" | "sentiment" | "ask" | "embed" | "polish";

export class AiUnavailable extends Error {
  readonly code = "AI_UNAVAILABLE";
  constructor(message = "Tất cả model AI đều lỗi hoặc hết quota") {
    super(message);
  }
}

/** AI trả lời nhưng nội dung không dùng được (rỗng, JSON hỏng). Khác với hết quota. */
export class AiBadOutput extends Error {
  readonly code = "AI_BAD_OUTPUT";
  constructor(message = "AI trả kết quả không dùng được") {
    super(message);
  }
}

export interface AiStore {
  getModels(task: AiTask): Promise<string[]>;
  logUsage(model: string, task: AiTask, is429: boolean): Promise<void>;
}

/**
 * Nhiệt độ riêng cho lượt VIẾT LẠI (force): không đặt thì Gemini chạy mặc
 * định và với cùng một đầu vào + format cứng, bản "viết lại" hội tụ gần như
 * y hệt bản cũ (Ethan test live 2026-10-26: bấm Viết lại mà như không).
 * Lượt sinh thường KHÔNG truyền temperature — giữ hành vi hiện tại.
 */
export const REWRITE_TEMPERATURE = 1.2;

export interface Ai {
  generate(
    task: Exclude<AiTask, "embed">,
    prompt: string,
    opts?: { schema?: Record<string, unknown>; temperature?: number },
  ): Promise<{ text: string; model: string }>;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const EMBED_BATCH = 100;
const EMBED_DIM = 768;

/** Key bị thu hồi/sai: thử key kế tiếp (đổi model không giúp được). */
function badKey(status: number, detail: string): boolean {
  return status === 401 || status === 403 || (status === 400 && detail.includes("API_KEY_INVALID"));
}

/** Lỗi đáng thử model kế tiếp: hết quota, model không tồn tại, lỗi phía Google. */
function retryable(status: number): boolean {
  return status === 429 || status === 404 || status >= 500;
}

/** Nhiều API key (free tier): key hết quota (429) thì xoay sang key kế tiếp, key vừa chạy được thử trước ở lần sau. */
export function createGemini(opts: { apiKeys: string[]; store: AiStore; fetch?: typeof fetch }): Ai {
  const doFetch = opts.fetch ?? fetch;
  const keys = opts.apiKeys.filter((k) => k.trim());
  if (!keys.length) throw new Error("Thiếu Gemini API key");
  let preferred = 0;

  async function log(model: string, task: AiTask, is429: boolean) {
    try {
      await opts.store.logUsage(model, task, is429);
    } catch (e) {
      console.error("ai usage log failed", e);
    }
  }

  /**
   * Thử lần lượt từng model của task. Trong một model: 429 hoặc key sai/bị thu hồi → key kế tiếp; 404/5xx/lỗi mạng → model kế tiếp
   * (đổi key không giúp được). Trả JSON response đầu tiên thành công.
   */
  async function call(task: AiTask, method: string, body: (model: string) => unknown): Promise<{ json: any; model: string }> {
    for (const model of await opts.store.getModels(task)) {
      for (let n = 0; n < keys.length; n++) {
        const k = (preferred + n) % keys.length;
        let res: Response;
        try {
          res = await doFetch(`${BASE}/${model}:${method}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": keys[k] },
            body: JSON.stringify(body(model)),
          });
        } catch {
          await log(model, task, false);
          break;
        }
        await log(model, task, res.status === 429);
        if (res.ok) {
          preferred = k;
          return { json: await res.json(), model };
        }
        const detail = await res.text().catch(() => "");
        if (res.status === 429 || badKey(res.status, detail)) continue;
        if (!retryable(res.status)) throw new Error(`Gemini ${model} ${res.status}: ${detail.slice(0, 300)}`);
        break;
      }
    }
    throw new AiUnavailable();
  }

  return {
    async generate(task, prompt, o = {}) {
      const generationConfig = {
        ...(o.schema ? { responseMimeType: "application/json", responseSchema: o.schema } : {}),
        ...(o.temperature != null ? { temperature: o.temperature } : {}),
      };
      const { json, model } = await call(task, "generateContent", () => ({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      }));
      const parts: { text?: string; thought?: boolean }[] = json?.candidates?.[0]?.content?.parts ?? [];
      return { text: parts.filter((p) => !p.thought).map((p) => p.text ?? "").join(""), model };
    },

    async embed(texts, kind) {
      const taskType = kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        const { json } = await call("embed", "batchEmbedContents", (model) => ({
          requests: batch.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: EMBED_DIM,
          })),
        }));
        const vectors: { values: number[] }[] = json?.embeddings ?? [];
        if (vectors.length !== batch.length) throw new Error("Gemini embed trả thiếu vector");
        out.push(...vectors.map((v) => v.values));
      }
      return out;
    },
  };
}
