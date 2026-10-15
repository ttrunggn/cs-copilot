// Test cần 2 kết nối song song (pgTAP không làm được). Chạy trên DB của SUPABASE_DB_URL, tự dọn dữ liệu.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";

const ca = readFileSync(new URL("../supabase/certs/prod-ca-2021.crt", import.meta.url), "utf8");
const client = () => new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: true, ca } });
const WS = "ws-concurrency";

function ev(session, fp, from, uid) {
  return JSON.stringify({
    website_id: WS,
    event: from === "user" ? "message:send" : "message:received",
    data: {
      session_id: session, fingerprint: fp, from, type: "text", content: "x", timestamp: 1760500000000 + fp,
      ...(uid ? { user: { user_id: uid, nickname: "Lan" } } : {}),
    },
  });
}

test("two new conversations getting operator replies in parallel do not deadlock", async () => {
  const admin = client();
  const a = client();
  const b = client();
  await Promise.all([admin.connect(), a.connect(), b.connect()]);
  await admin.query("insert into workspaces (website_id, name) values ($1, 'C') on conflict do nothing", [WS]);
  try {
    await a.query("begin");
    await b.query("begin");
    // Mỗi transaction tạo conversation mới (FK giữ KEY SHARE trên dòng workspace)...
    await a.query("select ingest_event($1::jsonb)", [ev("session_ca", 1, "user")]);
    await b.query("select ingest_event($1::jsonb)", [ev("session_cb", 1, "user")]);
    // ...rồi cùng lúc nhận tin operator (detect_bot đọc dòng workspace).
    const results = await Promise.allSettled([
      a.query("select ingest_event($1::jsonb)", [ev("session_ca", 2, "operator", "op-ca")]),
      b.query("select ingest_event($1::jsonb)", [ev("session_cb", 2, "operator", "op-cb")]),
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "fulfilled"],
      results.map((r) => r.reason?.message).filter(Boolean).join("; "),
    );
  } finally {
    await a.query("rollback").catch(() => {});
    await b.query("rollback").catch(() => {});
    await Promise.all([a.end(), b.end()]);
    await admin.query("delete from workspaces where website_id = $1", [WS]);
    await admin.query("delete from operators where crisp_user_id in ('op-ca', 'op-cb')");
    await admin.end();
  }
});
