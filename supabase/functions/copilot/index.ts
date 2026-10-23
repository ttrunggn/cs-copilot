import { createClient } from "npm:@supabase/supabase-js@2";
import { createAiStore, createDb } from "../_shared/db.ts";
import { createGemini } from "../_shared/gemini.ts";
import { createN8n } from "../_shared/n8n.ts";
import { secretOk } from "../_shared/secret.ts";
import { handle } from "./handler.ts";
import { handlePrecompute } from "./precompute.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-copilot-token, x-copilot-secret, apikey, authorization",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const db = createDb(sb);
// Nhiều key free tier, ngăn cách bằng dấu phẩy; key hết quota tự xoay sang key kế tiếp.
const ai = createGemini({ apiKeys: (Deno.env.get("GEMINI_API_KEYS") ?? Deno.env.get("GEMINI_API_KEY") ?? "").split(","), store: createAiStore(sb) });
const n8n = createN8n({ baseUrl: Deno.env.get("N8N_WEBHOOK_BASE")!, secret: Deno.env.get("N8N_SHARED_SECRET")! });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Chỉ hỗ trợ POST" });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body không phải JSON" });
  }
  // Route nội bộ: n8n gọi tính trước sentiment ngay sau khi ingest tin khách.
  // Credential: shared secret ở header x-copilot-secret, hoặc service role key
  // (n8n gọi bằng credential Supabase API có sẵn của nó: apikey/Bearer).
  if ((body as { action?: unknown } | null)?.action === "precompute_sentiment") {
    const presented = req.headers.get("x-copilot-secret") ?? req.headers.get("apikey") ??
      (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const shared = Deno.env.get("N8N_SHARED_SECRET") ?? "";
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!secretOk(presented, shared) && !secretOk(presented, service)) {
      return json(401, { error: "Thiếu credential nội bộ" });
    }
    const r = await handlePrecompute(body, { db, ai });
    return json(r.status, r.body);
  }
  const background = (task: Promise<unknown>) => {
    const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(task);
    else void task;
  };
  const r = await handle(body, req.headers.get("x-copilot-token") ?? "", { db, n8n, ai, background });
  return json(r.status, r.body);
});
