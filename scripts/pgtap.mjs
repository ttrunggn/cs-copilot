// Chạy test pgTAP trong supabase/tests/*.sql trên DB của SUPABASE_DB_URL (không cần Docker).
// Mỗi file tự begin/rollback nên không để lại dữ liệu.
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const dir = new URL("../supabase/tests/", import.meta.url);
const only = process.argv.slice(2);
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql") && (!only.length || only.includes(f))).sort();
if (!process.env.SUPABASE_DB_URL) throw new Error("Thiếu SUPABASE_DB_URL trong .env");

// Luôn kiểm tra chứng chỉ TLS. Pooler của Supabase ký bằng "Supabase Root 2021 CA" (supabase/certs).
function sslConfig() {
  const ca = process.env.SUPABASE_DB_CA ?? new URL("../supabase/certs/prod-ca-2021.crt", import.meta.url);
  return { rejectUnauthorized: true, ca: readFileSync(ca, "utf8") };
}

let failedFiles = 0;
for (const file of files) {
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: sslConfig() });
  await client.connect();
  const lines = [];
  try {
    const results = await client.query(await readFile(new URL(file, dir), "utf8"));
    for (const r of [].concat(results)) for (const row of r.rows ?? []) {
      const v = Object.values(row)[0];
      if (typeof v === "string" && /^(ok|not ok|1\.\.|#)/.test(v)) lines.push(v);
    }
  } catch (e) {
    lines.push(`not ok - ${file} errored: ${e.message}`);
    await client.query("rollback").catch(() => {});
  } finally {
    await client.end();
  }
  const plan = Number((lines.find((l) => /^1\.\.\d+/.test(l)) ?? "1..0").slice(3));
  const ok = lines.filter((l) => l.startsWith("ok")).length;
  const bad = lines.filter((l) => l.startsWith("not ok") || l.startsWith("# Looks like"));
  const pass = bad.length === 0 && plan > 0 && ok === plan;
  if (!pass) failedFiles++;
  console.log(`${pass ? "PASS" : "FAIL"} ${file} (${ok}/${plan})`);
  for (const l of bad) console.log(`  ${l}`);
}
console.log(failedFiles ? `${failedFiles} file(s) failed` : "all pgTAP files passed");
process.exit(failedFiles ? 1 : 0);
