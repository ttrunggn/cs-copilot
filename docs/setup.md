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
npx supabase secrets set N8N_WEBHOOK_BASE=<...> N8N_SHARED_SECRET=<...> GEMINI_API_KEYS=<key1,key2,...>
npx supabase functions deploy copilot --no-verify-jwt
npx supabase functions deploy embed-helpdesk --no-verify-jwt   # n8n gọi bằng header x-copilot-secret
```

## 4. n8n
1. Không cần biến môi trường đặc biệt: workflow không dùng `require('crypto')` (n8n chặn).
2. Import `n8n/copilot-gateway.json` (gộp 5 luồng: ingest, refresh, post note, crisp sync, helpdesk sync; sinh lại bằng `node n8n/build-gateway.mjs`). Chọn credential **Supabase API** có sẵn của n8n (Host = `SUPABASE_URL`, Service Role Secret = `SUPABASE_SERVICE_ROLE_KEY`) và Crisp (Basic Auth plugin token).
3. Thay `YOUR-PROJECT`, `REPLACE_N8N_SHARED_SECRET` (cả trong node `Helpdesk · Embed`), đổi `crisp-ingest-REPLACE-WITH-RANDOM`. Placeholder chưa thay thì workflow từ chối mọi request.
4. Activate.

## 5. Crisp
1. Web hook cho cả 2 website → Production URL của `Crisp Webhook`. Events: `message:send`, `message:received`, `session:set_segments`, `session:set_state`, `session:set_email`. Hook cấp website **không được Crisp ký**, nên giữ kín URL này (đường dẫn ngẫu nhiên là lớp bảo vệ duy nhất). Lộ URL thì đổi path ở cả n8n và Crisp.
2. Backfill: trong `crisp-sync` đặt `DAYS = 90` → Run Manually → xác nhận `List Conversations` gọi `/conversations/1`, `/2`, … rồi dừng ở trang rỗng → trả `DAYS = 1`.

## 5b. Helpdesk
1. Trong n8n bấm `Helpdesk · Run Manually` lần đầu (hoặc chạy từ máy: `node --env-file=.env scripts/helpdesk-sync.mjs <website_id> en`) (chỉ bài `published` được lưu, bài bị gỡ publish sẽ bị xoá ở lần sync sau).
2. Embed lần đầu: `node --env-file=.env scripts/embed-helpdesk.mjs` (lặp tới khi `remaining 0`). Các đêm sau node `Helpdesk · Embed` tự gọi.

## 5c. Widget + extension
1. Build extension: `node --env-file=.env scripts/build-extension.mjs` (cần `WIDGET_ORIGIN`), tạo `widget/extension.zip`.
2. Deploy cả thư mục `widget/` lên Netlify (cùng site). Team tải `extension.zip` từ widget → giải nén → `chrome://extensions` → Developer mode → Load unpacked.
3. Xem hiệu quả draft: `select * from draft_feedback_stats;` trong SQL Editor.

## 5d. Giọng văn từng CS (chạy tay, vd mỗi tuần)
```bash
deno run --env-file=.env --allow-net --allow-env --allow-read scripts/learn-profiles.ts <website_id>
# chỉ học lại giọng, không phân loại lại topic: thêm --skip-classify
```
Bộ topic theo tình huống thực tế: `node --env-file=.env scripts/derive-situations.mjs <website_id> > situations.json` (chỉ đọc), xem rồi cập nhật `supabase/seed/<app>-topics.json` + `workspaces.topics`. Sửa tay giọng một CS: ghi trường vào `agent_profiles.manual_override` (luôn thắng, lần học sau không ghi đè).

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
- Widget trong Crisp không cần token cá nhân: Edge Function tin `token` của website (Crisp gắn vào URL iframe) cộng `operator_id` do SDK báo. Hệ quả: một CS trong workspace có thể mạo danh CS khác; người đã nghỉ nếu giữ lại token website vẫn đọc được kết quả `check` khi biết `user_id` của một CS còn active. Khi có người nghỉ mà cần chặn ngay: tạo lại token website của plugin (cài lại plugin trên website), rồi cập nhật `workspaces.crisp_widget_token_hash` = sha256 của token mới.
