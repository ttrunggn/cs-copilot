// Đẩy supabase/migrations lên DB của SUPABASE_DB_URL (không cần Docker).
import { spawnSync } from "node:child_process";
if (!process.env.SUPABASE_DB_URL) throw new Error("Thiếu SUPABASE_DB_URL trong .env");
const r = spawnSync("npx", ["supabase", "db", "push", "--db-url", process.env.SUPABASE_DB_URL, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
