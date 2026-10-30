import { createClient } from "npm:@supabase/supabase-js@2";
import { crispFromEnv } from "../_shared/crisp.ts";
import { operatorMailerFromEnv } from "../_shared/crisp-operators.ts";
import { createAiStore, createDb, createJiraStore } from "../_shared/db.ts";
import { jiraFromEnv } from "../_shared/jira-api.ts";
import { createOpenAi } from "../_shared/openai.ts";
import { aiTraceSink } from "../_shared/trace.ts";
import { createN8n } from "../_shared/n8n.ts";
import { secretOk } from "../_shared/secret.ts";
import { storefrontFromEnv } from "../_shared/storefront.ts";
import { handle } from "./handler.ts";
import { handleNativeEvent, isNativeEvent } from "./native.ts";
import { handlePrecompute } from "./precompute.ts";
import { handleStorefrontSegments } from "./storefront-segments.ts";
import { handleStorefrontDigest } from "./storefront-digest.ts";
import { handleStorefrontReportAck, handleStorefrontReportPull } from "./storefront-report.ts";
import { handleStorefrontSweep } from "./storefront-sweep.ts";

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
// Nhiều key OpenAI, ngăn cách bằng dấu phẩy; key hết quota tự xoay sang key kế tiếp.
// Mọi lần thử gọi AI đều ghi tracing (model, thời lượng, token) vào trace_log.
const ai = createOpenAi({ apiKeys: (Deno.env.get("OPENAI_API_KEYS") ?? Deno.env.get("OPENAI_API_KEY") ?? "").split(","), store: createAiStore(sb), trace: aiTraceSink(db) });
const n8n = createN8n({ baseUrl: Deno.env.get("N8N_WEBHOOK_BASE")!, secret: Deno.env.get("N8N_SHARED_SECRET")! });
// Storefront Watch MCP (gọi trực tiếp, ký HMAC phía server): thiếu
// SW_API_TOKEN/SW_MCP_SIGNING_SECRET trong env → null, action trả unconfigured.
const storefront = storefrontFromEnv((k) => Deno.env.get(k));
// Client REST Crisp — CHỈ cho job đồng bộ segment `storefront-watch`
// (ngoại lệ ghi duy nhất Ethan đã duyệt, xem _shared/crisp.ts). Thiếu
// CRISP_PLUGIN_IDENTIFIER/CRISP_PLUGIN_KEY → null, job trả unconfigured.
const crisp = crispFromEnv((k) => Deno.env.get(k));
// Mailer gửi email digest Storefront Watch tới operator (Ethan duyệt
// 2026-10-27, xem _shared/crisp-operators.ts): dùng chung plugin token
// với client segment; thiếu credential → null, job digest trả
// mail_unconfigured.
const mailer = operatorMailerFromEnv((k) => Deno.env.get(k));
// Jira REST chỉ-đọc cho đường tự sync khi mở panel (Ethan chốt 2026-10-26):
// thiếu JIRA_EMAIL/JIRA_API_TOKEN → null, check giữ mirror cũ và nút Sync
// ngay báo unconfigured trung thực. Kho mirror dùng chung với function
// jira-sync (cùng pipeline applyJiraIssues — chỉ MỘT nguồn sync active).
const jira = jiraFromEnv((k) => Deno.env.get(k));
const jiraStore = createJiraStore(sb);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Chỉ hỗ trợ POST" });
  // Đọc RAW body trước: sự kiện Generic Widget cần nguyên văn để verify
  // chữ ký HMAC (parse rồi stringify lại không đảm bảo khớp byte).
  const rawBody = await req.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "Body không phải JSON" });
  }
  const background = (task: Promise<unknown>) => {
    const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(task);
    else void task;
  };
  // Mặt native (Crisp Generic Widget): sự kiện mang action dạng object và
  // chữ ký X-Crisp-Signature, KHÔNG mang credential nội bộ hay widget
  // token — phải rẽ nhánh TRƯỚC cả hai cổng auth dưới đây (xem native.ts).
  if (isNativeEvent(body)) {
    const r = await handleNativeEvent(body, rawBody, {
      signature: req.headers.get("x-crisp-signature"),
      timestamp: req.headers.get("x-crisp-request-timestamp"),
    }, { db, ai, n8n, background, pluginKey: Deno.env.get("CRISP_PLUGIN_KEY") ?? "" });
    return json(r.status, r.body);
  }
  // Các route nội bộ (n8n/lập lịch gọi): precompute sentiment ngay sau khi
  // ingest tin khách, job đối chiếu nền Storefront Watch, và job đồng bộ
  // segment `storefront-watch` (chạy sau sweep). Credential dùng chung:
  // shared secret ở header x-copilot-secret, hoặc service role key
  // (n8n gọi bằng credential Supabase API có sẵn của nó: apikey/Bearer).
  const internalAction = (body as { action?: unknown } | null)?.action;
  if (internalAction === "precompute_sentiment" || internalAction === "storefront_sweep" || internalAction === "storefront_segments" || internalAction === "storefront_digest" || internalAction === "storefront_report_pull" || internalAction === "storefront_report_ack") {
    const presented = req.headers.get("x-copilot-secret") ?? req.headers.get("apikey") ??
      (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const shared = Deno.env.get("N8N_SHARED_SECRET") ?? "";
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!secretOk(presented, shared) && !secretOk(presented, service)) {
      return json(401, { error: "Thiếu credential nội bộ" });
    }
    const r = internalAction === "precompute_sentiment"
      ? await handlePrecompute(body, { db, ai })
      : internalAction === "storefront_sweep"
      ? await handleStorefrontSweep(body, { db, storefront })
      : internalAction === "storefront_digest"
      ? await handleStorefrontDigest(body, { db, storefront, mailer })
      : internalAction === "storefront_report_pull"
      ? await handleStorefrontReportPull(body, { db })
      : internalAction === "storefront_report_ack"
      ? await handleStorefrontReportAck(body, { db })
      : await handleStorefrontSegments(body, { db, crisp });
    return json(r.status, r.body);
  }
  const r = await handle(body, req.headers.get("x-copilot-token") ?? "", { db, n8n, ai, background, storefront, jira, jiraStore, crisp });
  return json(r.status, r.body);
});
