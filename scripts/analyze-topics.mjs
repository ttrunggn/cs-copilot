// Phân tích chatlog thật để chốt danh sách topic: Gemini gán topic cho từng conversation rồi tổng hợp.
// Chạy: node --env-file=.env scripts/analyze-topics.mjs <website_id> [limit=400] > out.json
import { readFileSync } from "node:fs";
import pg from "pg";

const [websiteId, limitArg = "400"] = process.argv.slice(2);
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"];
const CANDIDATES = ["translation", "language_switcher", "currency", "language_setup", "geolocation", "onboarding", "billing", "other"];
const BATCH = 40;

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: true, ca: readFileSync(new URL("../supabase/certs/prod-ca-2021.crt", import.meta.url), "utf8") },
});
await db.connect();
const { rows } = await db.query(
  `select c.session_id, c.segments,
          (select string_agg(left(m.content, 300), ' | ' order by m.created_at)
             from (select content, created_at from messages
                   where website_id = c.website_id and session_id = c.session_id
                     and "from" = 'user' and type = 'text' and length(trim(content)) > 3
                   order by created_at limit 3) m) as customer_text,
          exists (select 1 from messages where website_id = c.website_id and session_id = c.session_id
                    and "from" = 'operator' and not is_bot and type <> 'note') as cs_replied
     from conversations c where c.website_id = $1
     order by c.updated_at desc limit $2`,
  [websiteId, Number(limitArg)],
);
await db.end();
const items = rows.filter((r) => r.customer_text);

async function classify(batch) {
  const prompt = `Bạn phân loại hội thoại hỗ trợ khách hàng của Transcy (app Shopify dịch store, đổi ngôn ngữ/tiền tệ, auto-detect theo vị trí).
Với mỗi hội thoại, chọn "topic" trong: ${CANDIDATES.join(", ")}. Nếu không khớp loại nào thì đặt "new:<tên_ngắn_tiếng_anh>".
"subtopic": vấn đề cụ thể, 2-5 từ tiếng Anh. "summary": tóm tắt vấn đề của khách bằng tiếng Việt, tối đa 12 từ. "language": mã ngôn ngữ khách dùng.
Hội thoại (id: tin của khách):
${batch.map((b, i) => `${i}: ${b.customer_text.replace(/\s+/g, " ")}`).join("\n")}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: { type: "OBJECT", properties: { id: { type: "INTEGER" }, topic: { type: "STRING" }, subtopic: { type: "STRING" }, summary: { type: "STRING" }, language: { type: "STRING" } }, required: ["id", "topic", "subtopic", "summary", "language"] },
      },
    },
  };
  for (const model of MODELS) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY }, body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) continue;
    const j = await res.json();
    if (j.error) throw new Error(`${model}: ${j.error.message}`);
    return { model, labels: JSON.parse(j.candidates[0].content.parts[0].text) };
  }
  throw new Error("all models unavailable");
}

const results = [];
for (let i = 0; i < items.length; i += BATCH) {
  const batch = items.slice(i, i + BATCH);
  const { model, labels } = await classify(batch);
  for (const l of labels) {
    const it = batch[l.id];
    if (it) results.push({ ...l, segments: it.segments, cs_replied: it.cs_replied, model });
  }
  console.error(`classified ${Math.min(i + BATCH, items.length)}/${items.length} (${model})`);
}

const count = (key, list = results) => Object.entries(list.reduce((a, r) => ((a[r[key]] = (a[r[key]] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]);
const byTopic = {};
for (const [topic, n] of count("topic")) {
  const list = results.filter((r) => r.topic === topic);
  byTopic[topic] = {
    count: n,
    share: `${Math.round((n / results.length) * 100)}%`,
    cs_replied: `${Math.round((list.filter((r) => r.cs_replied).length / n) * 100)}%`,
    top_subtopics: count("subtopic", list).slice(0, 6),
    examples: list.slice(0, 4).map((r) => r.summary),
  };
}
console.log(JSON.stringify({ analyzed: results.length, languages: count("language").slice(0, 8), topics: byTopic }, null, 2));
