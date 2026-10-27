import { createClient } from "npm:@supabase/supabase-js@2";
import { createAiStore, createDb } from "../_shared/db.ts";
import { createOpenAi } from "../_shared/openai.ts";
import { aiTraceSink } from "../_shared/trace.ts";
import { createN8n } from "../_shared/n8n.ts";
import { handleRpc } from "./handler.ts";

// Cổng MCP cho CS Copilot — cùng deps với function copilot, khác giao thức.
// Client gửi token CS cá nhân qua header x-copilot-token hoặc Authorization: Bearer.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-copilot-token, authorization, mcp-protocol-version",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  if (body === null) return new Response(null, { status, headers: CORS });
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const db = createDb(sb);
const ai = createOpenAi({ apiKeys: (Deno.env.get("OPENAI_API_KEYS") ?? Deno.env.get("OPENAI_API_KEY") ?? "").split(","), store: createAiStore(sb), trace: aiTraceSink(db) });
const n8n = createN8n({ baseUrl: Deno.env.get("N8N_WEBHOOK_BASE")!, secret: Deno.env.get("N8N_SHARED_SECRET")! });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Chỉ hỗ trợ POST (MCP Streamable HTTP)" });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Body không phải JSON" } });
  }
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const token = req.headers.get("x-copilot-token") ?? bearer;
  const background = (task: Promise<unknown>) => {
    const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(task);
    else void task;
  };
  const r = await handleRpc(body, token, { db, n8n, ai, background });
  return json(r.status, r.body);
});
