// Gọi Edge Function embed-helpdesk lặp lại tới khi hết bài chờ embed (dùng cho lần đồng bộ đầu tiên).
// Chạy: node --env-file=.env scripts/embed-helpdesk.mjs
const { SUPABASE_URL, N8N_SHARED_SECRET } = process.env;
if (!SUPABASE_URL || !N8N_SHARED_SECRET) throw new Error("Thiếu SUPABASE_URL hoặc N8N_SHARED_SECRET trong .env");

for (let round = 1; ; round++) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/embed-helpdesk`, {
    method: "POST",
    headers: { "x-copilot-secret": N8N_SHARED_SECRET },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`embed-helpdesk ${res.status}: ${JSON.stringify(body)}`);
  console.log(`round ${round}: embedded ${body.embedded}, remaining ${body.remaining}`);
  if (body.remaining === 0 || body.embedded === 0) break;
}
