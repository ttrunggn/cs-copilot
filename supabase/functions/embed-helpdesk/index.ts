import { createClient } from "npm:@supabase/supabase-js@2";
import { createAiStore, createDb, createHelpdeskStore } from "../_shared/db.ts";
import { createOpenAi } from "../_shared/openai.ts";
import { aiTraceSink } from "../_shared/trace.ts";
import { handleEmbed } from "./handler.ts";

// Deploy với --no-verify-jwt: n8n gọi bằng header x-copilot-secret (= N8N_SHARED_SECRET).
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const store = createHelpdeskStore(sb);
const ai = createOpenAi({ apiKeys: (Deno.env.get("OPENAI_API_KEYS") ?? Deno.env.get("OPENAI_API_KEY") ?? "").split(","), store: createAiStore(sb), trace: aiTraceSink(createDb(sb)) });
const secret = Deno.env.get("N8N_SHARED_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Chỉ hỗ trợ POST" }), { status: 405 });
  const r = await handleEmbed(req.headers.get("x-copilot-secret") ?? "", { store, ai, secret });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
});
