export type AiTask = "draft" | "verify" | "handoff" | "classify" | "translate" | "embed";

export class AiUnavailable extends Error {
  readonly code = "AI_UNAVAILABLE";
  constructor(message = "Tất cả model AI đều lỗi hoặc hết quota") {
    super(message);
  }
}

export interface AiStore {
  getModels(task: AiTask): Promise<string[]>;
  logUsage(model: string, task: AiTask, is429: boolean): Promise<void>;
}

export interface Ai {
  generate(
    task: Exclude<AiTask, "embed">,
    prompt: string,
    opts?: { schema?: Record<string, unknown> },
  ): Promise<{ text: string; model: string }>;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const EMBED_BATCH = 100;
const EMBED_DIM = 768;

/** Lỗi đáng thử model kế tiếp: hết quota, model không tồn tại, lỗi phía Google. */
function retryable(status: number): boolean {
  return status === 429 || status === 404 || status >= 500;
}

export function createGemini(opts: { apiKey: string; store: AiStore; fetch?: typeof fetch }): Ai {
  const doFetch = opts.fetch ?? fetch;

  async function log(model: string, task: AiTask, is429: boolean) {
    try {
      await opts.store.logUsage(model, task, is429);
    } catch (e) {
      console.error("ai usage log failed", e);
    }
  }

  /** Thử lần lượt từng model của task; trả JSON response của model đầu tiên thành công. */
  async function call(task: AiTask, method: string, body: (model: string) => unknown): Promise<{ json: any; model: string }> {
    for (const model of await opts.store.getModels(task)) {
      let res: Response;
      try {
        res = await doFetch(`${BASE}/${model}:${method}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
          body: JSON.stringify(body(model)),
        });
      } catch {
        await log(model, task, false);
        continue;
      }
      await log(model, task, res.status === 429);
      if (res.ok) return { json: await res.json(), model };
      const detail = await res.text().catch(() => "");
      if (!retryable(res.status)) throw new Error(`Gemini ${model} ${res.status}: ${detail.slice(0, 300)}`);
    }
    throw new AiUnavailable();
  }

  return {
    async generate(task, prompt, o = {}) {
      const { json, model } = await call(task, "generateContent", () => ({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(o.schema ? { generationConfig: { responseMimeType: "application/json", responseSchema: o.schema } } : {}),
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
