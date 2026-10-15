# CS Copilot v5 — Setup

Không cần Docker. Mọi lệnh chạy từ thư mục gốc repo.

## 1. Cấu hình local
1. `npm install`, cài Deno (`winget install DenoLand.Deno`).
2. `cp .env.example .env` rồi điền:
   - `SUPABASE_DB_URL`: Dashboard → Connect → Direct → **Session pooler**.
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: Project Settings → API Keys → Secret key.
   - `N8N_WEBHOOK_BASE`, `N8N_SHARED_SECRET` (`openssl rand -hex 24`, ≥ 32 ký tự).

## 2. Database
```bash
npm run db:push    # áp supabase/migrations
npm run db:test    # chạy pgTAP (mỗi file tự rollback)
deno task test     # test Edge Function + workflow n8n
```
Điền và chạy `supabase/seed/workspaces.example.sql` trong SQL Editor.

## 3. Edge Function
```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase secrets set N8N_WEBHOOK_BASE=<...> N8N_SHARED_SECRET=<...>
npx supabase functions deploy copilot --no-verify-jwt
```

## 4. n8n
1. Bật `NODE_FUNCTION_ALLOW_BUILTIN=crypto` cho instance n8n.
2. Import `n8n/copilot-gateway.json` (gộp 4 luồng; sinh lại bằng `node n8n/build-gateway.mjs`). Chọn credential **Supabase API** có sẵn của n8n (Host = `SUPABASE_URL`, Service Role Secret = `SUPABASE_SERVICE_ROLE_KEY`) và Crisp (Basic Auth plugin token).
3. Thay `YOUR-PROJECT`, `REPLACE_N8N_SHARED_SECRET`, `REPLACE_CRISP_HOOK_SECRET`, đổi `crisp-ingest-REPLACE-WITH-RANDOM`. Placeholder chưa thay thì workflow từ chối mọi request.
4. Activate.

## 5. Crisp
1. Web hook cho cả 2 website → Production URL của `Crisp Webhook`. Events: `message:send`, `message:received`, `session:set_segments`, `session:set_state`, `session:set_email`. Lấy signing secret điền vào `REPLACE_CRISP_HOOK_SECRET`.
2. Backfill: trong `crisp-sync` đặt `DAYS = 90` → Run Manually → xác nhận `List Conversations` gọi `/conversations/1`, `/2`, … rồi dừng ở trang rỗng → trả `DAYS = 1`.

## 6. Kiểm tra
```sql
select website_id, count(*) from conversations group by 1;
select website_id, bot_identifiers->'learned' from workspaces;   -- có mary/zoey
select crisp_user_id, display_name, email, public.issue_copilot_token(crisp_user_id) as token
from operators where email = '<email>';                          -- token chỉ hiện 1 lần
```
```bash
curl -s -X POST https://<project-ref>.supabase.co/functions/v1/copilot \
  -H 'content-type: application/json' -H 'x-copilot-token: <token>' \
  -d '{"website_id":"<website_id>","session_id":"<session_...>","action":"check"}'
```

## 7. Quyền của CS
- CS chỉ dùng được copilot khi `operator_workspaces.active = true`. Cờ này do `crisp-sync` (danh sách operator của Crisp) bật/tắt hằng đêm. CS chỉ xuất hiện qua tin nhắn sẽ chưa được kích hoạt, nên chạy `crisp-sync` trước khi cấp token.
- CS bị xoá khỏi website Crisp tự mất quyền sau lần sync kế tiếp. Thu hồi ngay lập tức:
  ```sql
  update public.operators set copilot_token_hash = null where email = '<email>';
  ```
- Cấp lại token (token cũ mất hiệu lực): `select public.issue_copilot_token('<crisp_user_id>');`
