// Nhúng lại TOÀN BỘ vector đã lưu bằng model embedding của OpenAI sau khi chuyển nhà
// (migration 029). Vector Gemini và vector OpenAI khác không gian — không nhúng lại thì
// match_helpdesk / match_cases trả kết quả vô nghĩa.
//   deno run --env-file=.env --allow-net --allow-env --allow-read scripts/reembed-openai.ts [--dry-run] [--only=helpdesk|cases]
// Chạy lại được nhiều lần (ghi đè cùng giá trị). Cần OPENAI_API_KEYS + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY trong .env.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createAiStore } from "../supabase/functions/_shared/db.ts";
import { createOpenAi } from "../supabase/functions/_shared/openai.ts";

const flags = new Set(Deno.args);
const dryRun = flags.has("--dry-run");
const only = Deno.args.find((a) => a.startsWith("--only="))?.split("=")[1] ?? "all";
if (!["all", "helpdesk", "cases"].includes(only)) throw new Error("--only nhận: helpdesk | cases");

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ai = createOpenAi({
  apiKeys: (Deno.env.get("OPENAI_API_KEYS") ?? Deno.env.get("OPENAI_API_KEY") ?? "").split(","),
  store: createAiStore(sb),
});

const PAGE = 200; // số dòng đọc mỗi trang
const BATCH = 100; // khớp EMBED_BATCH của client

async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function embedAll(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) out.push(...await ai.embed(texts.slice(i, i + BATCH), "document"));
  return out;
}

async function reembedHelpdesk() {
  const rows = await all<{ article_pk: number; chunk_idx: number; text: string }>((f, t) =>
    sb.from("helpdesk_chunks").select("article_pk, chunk_idx, text").order("article_pk").order("chunk_idx").range(f, t)
  );
  console.log(`helpdesk_chunks: ${rows.length} dòng`);
  if (dryRun) return;
  const vectors = await embedAll(rows.map((r) => r.text));
  for (let i = 0; i < rows.length; i++) {
    const { error } = await sb.from("helpdesk_chunks")
      .update({ embedding: JSON.stringify(vectors[i]) })
      .eq("article_pk", rows[i].article_pk).eq("chunk_idx", rows[i].chunk_idx);
    if (error) throw error;
    if ((i + 1) % 200 === 0) console.log(`  đã ghi ${i + 1}/${rows.length}`);
  }
  console.log("helpdesk_chunks: xong");
}

async function reembedCases() {
  const rows = await all<{ id: number; summary: string }>((f, t) =>
    sb.from("cases").select("id, summary").order("id").range(f, t)
  );
  console.log(`cases: ${rows.length} dòng`);
  if (dryRun) return;
  const vectors = await embedAll(rows.map((r) => r.summary));
  for (let i = 0; i < rows.length; i++) {
    const { error } = await sb.from("cases").update({ embedding: JSON.stringify(vectors[i]) }).eq("id", rows[i].id);
    if (error) throw error;
    if ((i + 1) % 200 === 0) console.log(`  đã ghi ${i + 1}/${rows.length}`);
  }
  console.log("cases: xong");
}

if (only === "all" || only === "helpdesk") await reembedHelpdesk();
if (only === "all" || only === "cases") await reembedCases();
console.log(dryRun ? "DRY RUN — không ghi gì." : "Hoàn tất nhúng lại.");
