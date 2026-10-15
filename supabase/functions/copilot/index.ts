import { createClient } from "npm:@supabase/supabase-js@2";
import { createDb } from "../_shared/db.ts";
import { createN8n } from "../_shared/n8n.ts";
import { handle } from "./handler.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-copilot-token",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

const db = createDb(createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!));
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
  const r = await handle(body, req.headers.get("x-copilot-token") ?? "", { db, n8n });
  return json(r.status, r.body);
});
