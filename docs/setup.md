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
npx supabase secrets set N8N_WEBHOOK_BASE=<...> N8N_SHARED_SECRET=<...> OPENAI_API_KEYS=<key1,key2,...>
npx supabase functions deploy copilot --no-verify-jwt
npx supabase functions deploy embed-helpdesk --no-verify-jwt   # n8n gọi bằng header x-copilot-secret
npx supabase functions deploy jira-sync --no-verify-jwt        # n8n gọi bằng header x-copilot-secret
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
# một lệnh làm 3 việc: phân loại topic chat mới, học giọng từng CS, tóm tắt chat đã resolve thành case tương tự
# bỏ bớt bước: --skip-classify / --skip-profiles / --skip-cases
```
Bộ topic theo tình huống thực tế: `node --env-file=.env scripts/derive-situations.mjs <website_id> > situations.json` (chỉ đọc), xem rồi cập nhật `supabase/seed/<app>-topics.json` + `workspaces.topics`. Sửa tay giọng một CS: ghi trường vào `agent_profiles.manual_override` (luôn thắng, lần học sau không ghi đè).

## 5e. Jira
1. `workspaces.jira_project` = project key (Transcy: `TNT`). CS dán link `https://<site>.atlassian.net/browse/TNT-123` vào **private note** là copilot tự theo dõi ticket đó (link trong tin gửi khách không tính).
2. Link đã có trong lịch sử chat: `select public.backfill_jira_links(<website_id>);` (theo dõi im lặng, không đăng note vào chat cũ).
3. n8n: tạo credential **Jira SW Cloud API** (email + API token tạo ở id.atlassian.com → Security → API tokens), chọn ở node `Jira · Search Jira`. Workflow chạy mỗi 5 phút.
4. Tắt 2 workflow v4 `crisp-jira-link-indexer` và `crisp-jira-sync-watcher` để không đăng note trùng.
5. Ticket Done trên Jira **không** tự biến mất khỏi panel: Done ≠ CS đã báo cho khách. Card ở lại với nhãn "Chờ báo khách" cho tới khi CS nhắn cho khách sau mốc ticket chuyển Done (khi đó panel tự ẩn, sync tắt link dọn dẹp) hoặc CS bấm "✕ Gỡ". Card có badge "Cập nhật mới" khi có đổi trạng thái (hiện "từ <cũ> → <mới>", nhờ `jira_issues.prev_status` do sync ghi lúc phát hiện đổi) hoặc comment mới sau lần CS trả lời gần nhất.

## 5f. Storefront Watch
1. Secrets của Edge Function: `SW_API_TOKEN` + `SW_MCP_SIGNING_SECRET` (copilot gọi MCP của SW trực tiếp, ký HMAC phía server). Thiếu một trong hai → module trả trạng thái "chưa cấu hình", không gọi bừa.
2. **Phạm vi SW — bật cờ cho workspace Transcy (bước cấu hình bắt buộc khi deploy):** `workspaces.storefront_watch` là định danh DUY NHẤT của phạm vi Storefront Watch (cột do migration 023 thêm, mặc định `false`). Chỉ bật `true` cho workspace của chính Transcy:
   ```sql
   update public.workspaces set storefront_watch = true where website_id = '<website_id workspace Transcy>';
   ```
   TUYỆT ĐỐI không suy phạm vi SW từ `jira_project`: workspace khác (OE) cũng có `jira_project` riêng (`OES`) và chat của họ cũng có `shopify_domain` — hai tín hiệu đó không chứng minh được store thuộc Transcy. Cờ tắt ở workspace nào thì ở đó: cổng domain không mở, job sweep bỏ qua, và `check` không trả badge `storefront_status`.
3. Cổng module: Storefront hiện khi chat có ticket thuộc Jira của workspace (`workspaces.jira_project` — đường này áp cho mọi workspace và là dự phòng khi domain không có/không được theo dõi), **hoặc** — chỉ trong workspace đã bật cờ `storefront_watch` — khi chat có `shopify_domain` trong dữ liệu visitor (custom data của Crisp) và domain đang được SW theo dõi, không cần ticket. Workspace khác giữ nguyên cổng theo ticket; domain Shopify một mình không mở được cổng ở workspace khác. Module là read-only: không scan/re-scan từ panel; mỗi finding có link sang đúng trang của nó trong console SW để người tự Mark fixed/Dismiss.
4. Job đối chiếu nền: gọi nội bộ `{"action":"storefront_sweep","website_id":"<id workspace Transcy>"}` (credential nội bộ như `precompute_sentiment`, vd từ node timer của n8n sau các đợt quét của SW; job tự bỏ qua nếu workspace chưa bật cờ `storefront_watch`). Job gom các domain duy nhất từ custom data của các conversation 30 ngày gần nhất, gọi `find_store` từng domain và ghi bản chụp vào `storefront_store_status` (chạy lại ghi đè, không nhân dữ liệu). Panel dùng bản chụp để hiện badge số lỗi đang mở ở khối Issue logs và quyết cổng Storefront tức thì; domain chưa có bản chụp thì module vẫn nạp trực tiếp khi mở.
5. Finding liên quan tới hội thoại (khớp trang/text lỗi) tự vào ngữ cảnh khi soạn draft, và mỗi finding có nút "Mẫu giải thích" (đoạn mẫu tiếng Anh theo loại lỗi) để điền vào ô Reply — vẫn là insert-only, CS tự bấm Send.
6. **Gắn segment `storefront-watch` tự động (ngoại lệ ghi Crisp duy nhất):** để các chat thuộc store đang có lỗi tự nổi lên trong inbox thay vì bắt CS vào SW search, một job nội bộ đồng bộ segment `storefront-watch` trên Crisp theo bản chụp: store còn lỗi mở → các conversation gần đây (30 ngày) của store đó mang segment; store hết lỗi/không còn được theo dõi → gỡ. Đây là ghi metadata (không tin nhắn, không note, khách không thấy); mỗi lần ghi đều đọc lại segments thật từ Crisp rồi MERGE (giữ nguyên mọi segment khác của CS), chỉ áp dụng trong workspace đã bật cờ `storefront_watch`, trần 200 lần ghi/lượt (phần còn lại báo ở `backlog` cho lượt sau).
   - Secrets của Edge Function: `CRISP_PLUGIN_IDENTIFIER` + `CRISP_PLUGIN_KEY` — plugin token tạo ở Crisp Marketplace với scope `website:conversation:sessions` (quota plugin 5.000 req/ngày). Thiếu một trong hai → job trả `skipped: "unconfigured"`, không gọi bừa.
   - Lập lịch: gọi nội bộ `{"action":"storefront_segments","website_id":"<id workspace Transcy>"}` (credential nội bộ như các job trên) NGAY SAU `storefront_sweep` để bản chụp là mới nhất; hai job độc lập, job segment tự bỏ qua nếu workspace chưa bật cờ.

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
