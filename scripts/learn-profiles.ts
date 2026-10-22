// Học giọng văn từng CS từ chatlog 90 ngày. Chạy tay khi muốn cập nhật (vd mỗi tuần):
//   deno run --env-file=.env --allow-net --allow-env --allow-read scripts/learn-profiles.ts <website_id> [--skip-classify] [--skip-profiles] [--skip-note-formats] [--skip-cases]
// 1) Phân loại topic theo lô cho hội thoại chưa có topic (theo bộ topic của workspace).
// 2) Mỗi CS: profile "_all" + profile riêng cho topic có ≥ min_conversations_per_topic hội thoại.
//    Bỏ chat email hệ thống. Trường nào có trong manual_override vẫn thắng lúc dùng (không bị ghi đè).
// 2b) Format private note theo từng CS, học từ note cũ (type='note') của chính CS, lưu ở dòng "_all".
// 3) Tóm tắt hội thoại đã resolve chưa có trong `cases` thành case tương tự cho Soạn tin.
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
  MIN_NOTES_FOR_FORMAT,
  NOTE_LEARN_SCHEMA,
  noteLearnPrompt,
  type OpMessage,
  parseClassifyBatch,
  parseLearned,
  parseNoteFormat,
  pickNoteSamples,
  pickSamples,
  SKIP_TOPICS,
} from "../supabase/functions/_shared/learn.ts";
import { casePrompt, caseSchema, lastAgentReply, parseCases } from "../supabase/functions/_shared/cases.ts";
import { humanTranscript } from "../supabase/functions/_shared/context.ts";
import type { MessageRow, Topic } from "../supabase/functions/_shared/types.ts";

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

for (const [opId, groups] of flags.includes("--skip-profiles") ? [] : groupForLearning(opMsgs, topicOf, ws.min_conversations_per_topic)) {
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

// ---------- 2b) học format private note theo từng CS ----------
// Nguồn: note cũ (type='note') của chính CS đó trong messages — không thu thập gì mới.
// Chỉ học khi CS có ≥ MIN_NOTES_FOR_FORMAT note dùng được; lưu vào dòng "_all" (cột note_format).
// Format là thói quen cá nhân nên không theo topic. Chạy cùng nhịp học giọng văn; tắt bằng --skip-note-formats.
if (!flags.includes("--skip-profiles") && !flags.includes("--skip-note-formats")) {
  const opNotes = await all<OpMessage>((a, b) =>
    sb.from("messages").select("operator_id,session_id,content,created_at").eq("website_id", websiteId).eq("from", "operator")
      .eq("type", "note").eq("is_bot", false).not("operator_id", "is", null).gt("created_at", since).order("id").range(a, b)
  );
  const notesByOp = new Map<string, OpMessage[]>();
  for (const m of opNotes) {
    if (SKIP_TOPICS.includes(topicOf.get(m.session_id) ?? "")) continue;
    if (!notesByOp.has(m.operator_id)) notesByOp.set(m.operator_id, []);
    notesByOp.get(m.operator_id)!.push(m);
  }
  for (const [opId, notes] of notesByOp) {
    const samples = pickNoteSamples(notes);
    const name = nameOf.get(opId) ?? opId;
    if (samples.length < MIN_NOTES_FOR_FORMAT) {
      console.log(`- ${name} / note format: chỉ ${samples.length} note dùng được (< ${MIN_NOTES_FOR_FORMAT}), giữ template cố định`);
      continue;
    }
    try {
      const { text } = await ai.generate("learn", noteLearnPrompt(name, samples), { schema: NOTE_LEARN_SCHEMA });
      const fmt = parseNoteFormat(text, samples.length);
      const { error } = await sb.from("agent_profiles").upsert({
        crisp_user_id: opId,
        website_id: websiteId,
        topic: "_all",
        note_format: fmt,
      }, { onConflict: "crisp_user_id,website_id,topic" });
      if (error) throw error;
      console.log(`- ${name} / note format: ${fmt.language}, mục [${fmt.sections.map((s) => s.field).join(" > ") || "mặc định"}], ${fmt.line_style} (${samples.length} note)`);
    } catch (e) {
      console.warn(`- ${name} / note format: lỗi ${e instanceof Error ? e.message : e}`);
    }
  }
}

// ---------- 3) case tương tự ----------
// Hội thoại đã resolve có CS người thật trả lời, chưa có trong `cases` → tóm tắt + embed để Soạn tin tham khảo.
if (!flags.includes("--skip-cases")) {
  const CASE_BATCH = 8;
  const done = new Set(
    (await all<{ session_id: string }>((a, b) => sb.from("cases").select("session_id").eq("website_id", websiteId).range(a, b)))
      .map((r) => r.session_id),
  );
  const resolved = await all<{ session_id: string; topic: string | null; resolved_at: string | null; updated_at: string }>((a, b) =>
    sb.from("conversations").select("session_id,topic,resolved_at,updated_at").eq("website_id", websiteId).eq("state", "resolved")
      .gt("updated_at", since).range(a, b)
  );
  const rows = await all<MessageRow & { session_id: string }>((a, b) =>
    sb.from("messages").select("id,session_id,from,type,is_bot,content,content_en,created_at,operator_name").eq("website_id", websiteId)
      .gt("created_at", since).order("id").range(a, b)
  );
  const bySession = new Map<string, MessageRow[]>();
  for (const r of rows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id)!.push(r);
  }
  const todo = resolved
    .filter((c) => !done.has(c.session_id) && !SKIP_TOPICS.includes(c.topic ?? ""))
    .map((c) => ({ c, msgs: bySession.get(c.session_id) ?? [] }))
    .filter(({ msgs }) => lastAgentReply(msgs));
  console.log(`tóm tắt ${todo.length} hội thoại đã resolve thành case…`);
  let saved = 0, skipped = 0;
  for (let i = 0; i < todo.length; i += CASE_BATCH) {
    const batch = todo.slice(i, i + CASE_BATCH);
    try {
      const { text } = await ai.generate("case_summary", casePrompt(batch.map(({ msgs }, j) => ({ i: j, transcript: humanTranscript(msgs, 30) }))), {
        schema: caseSchema,
      });
      const parsed = parseCases(text, batch.length);
      const keep = batch.map((b, j) => ({ ...b, sum: parsed.get(j) })).filter((b) => b.sum);
      skipped += batch.length - keep.length;
      if (!keep.length) continue;
      const vectors = await ai.embed(keep.map((k) => k.sum!.summary), "document");
      const { error } = await sb.from("cases").upsert(keep.map((k, j) => ({
        website_id: websiteId,
        session_id: k.c.session_id,
        topic: k.c.topic,
        summary: k.sum!.summary,
        resolution: k.sum!.resolution,
        final_reply: lastAgentReply(k.msgs),
        embedding: JSON.stringify(vectors[j]),
        resolved_at: k.c.resolved_at ?? k.c.updated_at,
      })), { onConflict: "website_id,session_id" });
      if (error) throw error;
      saved += keep.length;
    } catch (e) {
      console.warn(`lô case ${i / CASE_BATCH + 1} lỗi, bỏ qua: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`đã lưu ${saved} case, bỏ qua ${skipped} hội thoại không có cách xử lý đáng dùng lại`);
}
