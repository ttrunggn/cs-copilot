// Backfill conversation + tin nhắn từ Crisp vào Supabase qua RPC ingest_events (giống workflow crisp-sync).
// Chạy: node --env-file=.env scripts/backfill.mjs <website_id> [days=90]
// Mỗi conversation chỉ lấy trang tin mới nhất của Crisp (đủ cho học tone; conversation rất dài sẽ thiếu tin cũ).
import { readFileSync } from "node:fs";
import pg from "pg";

const [websiteId, daysArg = "90"] = process.argv.slice(2);
if (!/^[\w-]+$/.test(websiteId ?? "")) throw new Error("Cách dùng: backfill.mjs <website_id> [days]");
const since = Date.now() - Number(daysArg) * 86400000;
const auth = "Basic " + Buffer.from(`${process.env.CRISP_IDENTIFIER}:${process.env.CRISP_KEY}`).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function crisp(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://api.crisp.chat/v1${path}`, { headers: { Authorization: auth, "X-Crisp-Tier": "plugin" } });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const j = await res.json();
    if (j.error) throw new Error(`${path}: ${j.reason}`);
    return j.data;
  }
  throw new Error(`${path}: rate limited`);
}

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: true, ca: readFileSync(new URL("../supabase/certs/prod-ca-2021.crt", import.meta.url), "utf8") },
});
await db.connect();

let page = 1, convs = 0, msgs = 0, done = false;
while (!done) {
  const list = await crisp(`/website/${websiteId}/conversations/${page}`);
  if (!list?.length) break;
  for (const c of list) {
    if ((c.updated_at ?? c.created_at) < since) { done = true; break; }
    const messages = (await crisp(`/website/${websiteId}/conversation/${c.session_id}/messages`)) ?? [];
    const events = [{ website_id: websiteId, event: "session:meta", data: { session_id: c.session_id, email: c.meta?.email ?? null, nickname: c.meta?.nickname ?? null, segments: c.meta?.segments ?? [], state: c.state ?? null } }];
    for (const m of messages) events.push({ website_id: websiteId, event: "message:import", data: { ...m, session_id: c.session_id } });
    await db.query("select ingest_events($1::jsonb)", [JSON.stringify(events)]);
    convs++; msgs += messages.length;
    await sleep(150);
  }
  console.log(`page ${page}: total ${convs} conversations, ${msgs} messages`);
  page++;
}
await db.end();
console.log(`done: ${convs} conversations, ${msgs} messages (last ${daysArg} days)`);
