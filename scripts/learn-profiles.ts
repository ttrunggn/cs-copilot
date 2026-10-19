// Học giọng văn từng CS từ chatlog 90 ngày. Chạy tay khi muốn cập nhật (vd mỗi tuần):
//   deno run --env-file=.env --allow-net --allow-env --allow-read scripts/learn-profiles.ts <website_id> [--skip-classify]
// 1) Phân loại topic theo lô cho hội thoại chưa có topic (theo bộ topic của workspace).
// 2) Mỗi CS: profile "_all" + profile riêng cho topic có ≥ min_conversations_per_topic hội thoại.
//    Bỏ chat email hệ thống. Trường nào có trong manual_override vẫn thắng lúc dùng (không bị ghi đè).
import { createClient } from "npm:@supabase/supabase-js@2";
import { createAiStore } from "../supabase/functions/_shared/db.ts";
import { createGemini } from "../supabase/functions/_shared/gemini.ts";
import {
  classifyBatchPrompt,
  classifyBatchSchema,
  customerSnippets,
  groupForLearning,
  LEARN_SCHEMA,
  learnPrompt,
  type OpMessage,
  parseClassifyBatch,
  parseLearned,
  pickSamples,
} from "../supabase/functions/_shared/learn.ts";
import type { Topic } from "../supabase/functions/_shared/types.ts";

const [websiteId, ...flags] = Deno.args;
if (!websiteId) throw new Error("Cần website_id");
const DAYS = 90;
const CLASSIFY_BATCH = 20;
const MIN_SAMPLES = 5;
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ai = createGemini({
  apiKeys: (Deno.env.get("GEMINI_API_KEYS") ?? Deno.env.get("GEMINI_API_KEY") ?? "").split(","),
  store: createAiStore(sb),
});

/** Đọc hết các trang (PostgREST trả tối đa 1000 dòng mỗi lần). */
async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

const { data: ws, error: wsErr } = await sb.from("workspaces").select("name,topics,min_conversations_per_topic")
  .eq("website_id", websiteId).single();
if (wsErr) throw wsErr;
const topics = ws.topics as Topic[];
console.log(`workspace ${ws.name}: ${topics.length} topics, ngưỡng ${ws.min_conversations_per_topic} hội thoại/topic`);

// ---------- 1) phân loại topic ----------
if (!flags.includes("--skip-classify") && topics.length) {
  const untagged = new Set(
    (await all<{ session_id: string }>((a, b) =>
      sb.from("conversations").select("session_id").eq("website_id", websiteId).is("topic", null).range(a, b)
    )).map((r) => r.session_id),
  );
  const customer = await all<{ session_id: string; content: string; created_at: string }>((a, b) =>
    sb.from("messages").select("session_id,content,created_at").eq("website_id", websiteId).eq("from", "user")
      .eq("type", "text").eq("is_bot", false).gt("created_at", since).order("id").range(a, b)
  );
  const snippets = [...customerSnippets(customer.filter((m) => untagged.has(m.session_id)))].filter(([, t]) => t.trim());
  console.log(`phân loại ${snippets.length} hội thoại chưa có topic…`);
  let done = 0;
  for (let i = 0; i < snippets.length; i += CLASSIFY_BATCH) {
    const batch = snippets.slice(i, i + CLASSIFY_BATCH);
    try {
      const { text } = await ai.generate("classify", classifyBatchPrompt(batch.map(([, t], j) => ({ i: j, text: t })), topics), {
        schema: classifyBatchSchema(topics),
      });
      const byTopic = new Map<string, string[]>();
      for (const [j, key] of parseClassifyBatch(text, batch.length, topics)) {
        if (!byTopic.has(key)) byTopic.set(key, []);
        byTopic.get(key)!.push(batch[j][0]);
      }
      for (const [key, ids] of byTopic) {
        const { error } = await sb.from("conversations").update({ topic: key, topic_source: "ai" })
          .eq("website_id", websiteId).in("session_id", ids).is("topic", null);
        if (error) throw error;
        done += ids.length;
      }
    } catch (e) {
      console.warn(`lô ${i / CLASSIFY_BATCH + 1} lỗi, bỏ qua: ${e instanceof Error ? e.message : e}`);
    }
    if ((i / CLASSIFY_BATCH) % 10 === 9) console.log(`  ${Math.min(i + CLASSIFY_BATCH, snippets.length)}/${snippets.length}`);
  }
  console.log(`đã gán topic cho ${done} hội thoại`);
}

// ---------- 2) học giọng văn ----------
const convs = await all<{ session_id: string; topic: string | null }>((a, b) =>
  sb.from("conversations").select("session_id,topic").eq("website_id", websiteId).range(a, b)
);
const topicOf = new Map(convs.map((c) => [c.session_id, c.topic]));
const opMsgs = await all<OpMessage>((a, b) =>
  sb.from("messages").select("operator_id,session_id,content,created_at").eq("website_id", websiteId).eq("from", "operator")
    .eq("type", "text").eq("is_bot", false).not("operator_id", "is", null).gt("created_at", since).order("id").range(a, b)
);
const { data: ops } = await sb.from("operators").select("crisp_user_id,display_name");
const nameOf = new Map((ops ?? []).map((o) => [o.crisp_user_id as string, (o.display_name as string) ?? o.crisp_user_id]));
const label = (key: string) => (key === "_all" ? null : topics.find((t) => t.key === key)?.label ?? key);

for (const [opId, groups] of groupForLearning(opMsgs, topicOf, ws.min_conversations_per_topic)) {
  for (const [topic, msgs] of groups) {
    const samples = pickSamples(msgs);
    const name = nameOf.get(opId) ?? opId;
    if (samples.length < MIN_SAMPLES) {
      console.log(`- ${name} / ${topic}: chỉ ${samples.length} tin mẫu, bỏ qua`);
      continue;
    }
    try {
      const { text } = await ai.generate("learn", learnPrompt(name, samples, label(topic)), { schema: LEARN_SCHEMA });
      const p = parseLearned(text, samples);
      const { error } = await sb.from("agent_profiles").upsert({
        crisp_user_id: opId,
        website_id: websiteId,
        topic,
        ...p,
        conversations_used: new Set(msgs.map((m) => m.session_id)).size,
        learned_at: new Date().toISOString(),
      }, { onConflict: "crisp_user_id,website_id,topic" });
      if (error) throw error;
      console.log(`- ${name} / ${topic}: ${p.tone} (${p.sample_messages.length} tin mẫu)`);
    } catch (e) {
      console.warn(`- ${name} / ${topic}: lỗi ${e instanceof Error ? e.message : e}`);
    }
  }
}
