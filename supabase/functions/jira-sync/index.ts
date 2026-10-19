import { createClient } from "npm:@supabase/supabase-js@2";
import { createJiraStore } from "../_shared/db.ts";
import { createN8n } from "../_shared/n8n.ts";
import { handleJiraSync } from "./handler.ts";

// Deploy với --no-verify-jwt: n8n gọi bằng header x-copilot-secret (= N8N_SHARED_SECRET).
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const store = createJiraStore(sb);
const n8n = createN8n({ baseUrl: Deno.env.get("N8N_WEBHOOK_BASE")!, secret: Deno.env.get("N8N_SHARED_SECRET")! });
const secret = Deno.env.get("N8N_SHARED_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Chỉ hỗ trợ POST" }), { status: 405 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body không phải JSON" }), { status: 400 });
  }
  const r = await handleJiraSync(req.headers.get("x-copilot-secret") ?? "", body, { store, n8n, secret });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
});
