# CS Copilot v5 — Multi-workspace design

- Ngày: 2026-10-15
- Chủ sở hữu: Trung (tool cá nhân hỗ trợ team CS, không phải sản phẩm công ty)
- Kế thừa từ: `crisp-reply-assistant-v4`, `crisp-jira-link-indexer`, `crisp-jira-sync-watcher`, `crisp-jira-attachment-proxy`

## 1. Mục tiêu

Một copilot trong sidebar Crisp, dùng chung cho **2 Crisp workspace** (2 app khác nhau), giúp từng CS:

1. **Soạn tin** gửi khách theo đúng **giọng văn của chính CS đó**, theo **từng topic**, học từ lịch sử chat **90 ngày gần nhất**.
2. **Đối chiếu draft với Crisp Helpdesk** của workspace để không trả lời theo thông tin cũ, có cảnh báo ⚠ kèm link bài viết.
3. **Tóm tắt / Handoff** một conversation chưa đóng (chỉ phần CS xử lý, bỏ chatbot) khi CS bấm nút.
4. **Theo dõi Jira** từ tin cuối của CS: status đổi, comment mới. Tự đăng note vào Crisp khi có thay đổi.
5. **Draft điền thẳng vào ô Reply** của Crisp (qua Chrome extension). CS đọc, sửa, rồi tự bấm Send.
6. **Vòng phản hồi**: lưu draft và tin CS thực sự gửi, đo mức CS phải sửa, chạy A/B giữa các phiên bản prompt để cải thiện draft về sau.

### Ngoài phạm vi
- Tự gửi tin cho khách (copilot chỉ tạo private note).
- Handoff hàng loạt cuối shift (handoff chỉ chạy khi CS bấm cho từng chat).
- Dashboard / báo cáo.
- Quy trình rollout cấp công ty.

### Tiêu chí thành công
- CS ở cả 2 workspace dùng cùng một widget + extension, mọi thứ tự phân theo `website_id`.
- Draft của CS A khác draft của CS B về văn phong khi cùng một tình huống.
- Không có tin của Mary/Zoey trong tóm tắt, dữ liệu học tone, hay mốc "tin cuối của CS".
- Draft nêu thông tin trái helpdesk thì có cảnh báo ⚠.

## 2. Quyết định đã chốt

| Chủ đề | Quyết định |
|---|---|
| Workspace | 2 app khác nhau, helpdesk riêng. CS có thể làm ở cả 2 |
| Jira | 1 site, mỗi workspace một project, 1 credential |
| Kiến trúc | **Supabase = hạ tầng** (DB, logic, cron). **n8n = cổng kết nối** (chỉ I/O) |
| AI | Gemini API free tier, gọi từ Edge Function. Công ty đã chấp nhận điều khoản dữ liệu của free tier. Volume không chạm trần |
| Topic | Ưu tiên segment Crisp → không khớp thì Gemini phân loại vào cùng danh sách topic |
| Verify | Grounding bằng helpdesk + bước verify riêng trả cảnh báo ⚠, không tự sửa draft |
| Cửa sổ 90 ngày | Áp dụng cho cả học tone lẫn tìm case tương tự. Helpdesk luôn là bản hiện tại |
| Tóm tắt & handoff | Gộp thành 1 nút, đăng private note |
| Jira auto-note | Giữ: tự đăng note khi ticket thay đổi |
| Ngưỡng profile theo topic | ≥ 5 hội thoại trong 90 ngày (config `min_conversations_per_topic`) |
| Bot | Mary, Zoey. Nhận diện theo nickname lần đầu rồi cố định theo `user_id` |
| Giao diện | **Lai**: Crisp Plugin Widget (sidebar) làm toàn bộ UI + gọi API; Chrome extension **chỉ** chèn chữ vào ô Reply (Widget SDK của Crisp không ghi được vào ô soạn tin). Thiếu extension thì widget chuyển sang nút Copy |
| Xác thực | **Widget trong Crisp:** không cần nhập gì. Crisp gắn `token` của website vào URL iframe; Edge Function so sha256 với `workspaces.crisp_widget_token_hash` (lấy từ API "List all connect websites" của plugin) và kiểm tra operator (từ `$crisp.acquireData("operator")`) đang active trong workspace. **Công cụ/curl:** token cá nhân qua header `x-copilot-token` (hash trong `operators`). Đánh đổi: danh tính CS do trình duyệt báo, một CS trong workspace có thể mạo danh CS khác; người ngoài workspace thì không |
| Draft | Điền vào ô Reply, **không** đăng private note. Handoff vẫn đăng note |
| Vòng phản hồi | Ghép draft với tin CS gửi sau đó (cùng CS, cùng session, ≤ 15 phút), đo `edit_ratio`, A/B theo `prompt_version` |
| Ngôn ngữ | **CS chỉ trả lời bằng tiếng Anh.** Draft luôn tiếng Anh. Tin khách không phải tiếng Anh (~22% ở Transcy) được dịch sang tiếng Anh trước khi đưa vào prompt soạn tin, handoff, phân loại topic và học giọng văn; bản gốc giữ trong `messages`. `check` không gọi AI nên hiển thị nguyên văn |

## 3. Kiến trúc

```
 Crisp (2 website)     Jira       Crisp Helpdesk (2)            Gemini
       │                 │               │                        ▲
       ▼                 ▼               ▼                        │
 ┌──────────────── n8n — cổng I/O, không business logic ───────┐  │
 │ ingest webhook · refresh conversation · Jira sync ·         │  │
 │ helpdesk sync · post note · attachment proxy                │  │
 └──────────────────────────────┬──────────────────────────────┘  │
                                ▼                                 │
 ┌──────────────── Supabase ───────────────────────────────────┐  │
 │ Postgres + pgvector (dữ liệu)                               │  │
 │ Edge Functions: copilot, learn-profiles, classify-topics,   │──┘
 │                 index-cases, jira-diff                      │
 │ pg_cron: lịch job nền + cleanup 90 ngày                     │
 └──────────────────────────────▲──────────────────────────────┘
                                │
          Crisp Plugin Widget (sidebar) ──► Extension chèn vào ô Reply
```

**Nguyên tắc phân vai**
- Credential Crisp và Jira **chỉ nằm trong n8n**. Supabase không gọi trực tiếp Crisp/Jira mà gọi webhook n8n.
- Edge Functions chỉ đọc dữ liệu đã có trong DB (cộng một lần refresh qua n8n), nên chạy nhanh và test được.
- Key Gemini nằm trong Supabase secrets.
- n8n gọi Supabase bằng service role key. Edge Function gọi n8n bằng header secret dùng chung (`N8N_SHARED_SECRET`).

## 4. Data model

Mọi bảng nghiệp vụ đều có `website_id`.

### 4.1 Cấu hình
- **`workspaces`**: `website_id` PK, `name`, `jira_project`, `helpdesk_locale`, `topics jsonb` (`[{key, label, segments: []}]`), `bot_identifiers jsonb` (`{nicknames: ["Mary","Zoey"], learned: {"mary": "<user_id>"}}`: lần đầu gặp nickname bot thì ghi `user_id` vào `learned`; từ đó nickname trùng nhưng khác `user_id` là người thật, còn `user_id` đã học luôn là bot dù đổi nickname), `cs_jira_authors text[]`, `default_profile jsonb`, `min_conversations_per_topic int default 5`, `jira_auto_note bool default true`.
- **`operators`**: `crisp_user_id` PK, `email`, `display_name`, `jira_display_name`, `copilot_token_hash` (sha256 hex, unique). Token cấp bằng RPC `issue_copilot_token(crisp_user_id)`, chỉ hiện plaintext một lần.
- **`operator_workspaces`**: `(crisp_user_id, website_id)` PK, `active`.
- **`ai_config`**: `task` PK (`draft`, `verify`, `handoff`, `classify`, `learn`, `case_summary`, `embed`), `models text[]` theo thứ tự fallback. Mặc định: `['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']`, embed `['gemini-embedding-2']`.
- **`ai_usage_log`**: `day`, `model`, `task`, `calls`, `errors_429`.

### 4.2 Hội thoại (giữ 90 ngày)
- **`conversations`**: `(website_id, session_id)` PK, `customer_email`, `customer_name`, `segments text[]`, `topic`, `topic_source` (`segment`|`ai`|null), `state`, `assigned_operator`, `last_customer_at`, `last_human_operator_at`, `resolved_at`, `updated_at`.
- **`messages`**: `id`, `website_id`, `session_id`, `fingerprint` (unique theo website+session), `from` (`user`|`operator`), `type`, `operator_id`, `is_bot bool`, `content text`, `created_at`.
  - `is_bot = true` khi operator nickname hoặc user_id khớp `bot_identifiers`, hoặc khi đó là QA note của bot.
  - Note do chính copilot tạo (prefix 🤖) cũng đánh `is_bot = true`.

### 4.3 Tone voice
- **`agent_profiles`**: `(crisp_user_id, website_id, topic)` PK. `topic='_all'` là profile chung.
  - Các trường: `tone`, `pronoun_self`, `pronoun_customer`, `use_emoji`, `signature`, `sample_messages text[]`, `style_notes`, `conversations_used int`, `learned_at`, `manual_override jsonb`.
  - Trường nào có trong `manual_override` thì luôn thắng giá trị học được, và job học không ghi đè.
- Thứ tự chọn profile: **CS × topic → CS × `_all` → `workspaces.default_profile`**.

### 4.4 Tri thức
- **`cases`**: `id`, `website_id`, `session_id`, `topic`, `summary`, `resolution`, `final_reply`, `embedding vector(768)`, `resolved_at`. RPC `match_cases(website_id, embedding, k)` chỉ trả case có `resolved_at > now() - 90 days`.
- **`helpdesk_articles`**: `id`, `website_id`, `locale`, `article_id`, `title`, `url`, `content_md`, `content_hash`, `updated_at`.
- **`helpdesk_chunks`**: `article_id`, `chunk_idx`, `text`, `embedding vector(768)`. RPC `match_helpdesk(website_id, embedding, k)`.

### 4.5 Jira
- **`jira_links`**: `(website_id, session_id, issue_key)`, `created_by`, `created_at`, `last_notified_at`, `last_seen_status`, `last_seen_comment_id`.
- **`jira_issues`**: `issue_key` PK, `summary`, `status`, `status_category`, `assignee`, `updated_at`, `status_changed_at`.
- **`jira_comments`**: `id` PK, `issue_key`, `author`, `role` (`tech`|`cs`|`bot`), `is_public`, `body_text`, `created_at`.

**Nguồn ticket tin cậy:** Jira context của một conversation **chỉ** lấy từ `jira_links`, tức các link do CS dán trong private note và được `jira-link-indexer` ghi lại. Không tìm ticket theo email khách hay `meta.data` của Crisp, vì cả hai đều do phía khách ghi được (khác với v4). Meta `jira_keys` ghi ngược vào Crisp chỉ để hiển thị, không bao giờ được đọc lại làm nguồn. Mọi issue key phải khớp `^[A-Z][A-Z0-9_]+-\d+$` và thuộc `workspaces.jira_project` trước khi đưa vào JQL.

### 4.6 Output
- **`outputs`**: `id`, `website_id`, `session_id`, `operator_id`, `kind` (`draft`|`handoff`), `input_fp`, `content`, `warnings jsonb` (`[{claim, reason, article_url}]`), `topic`, `profile_used`, `model`, `prompt_version`, `created_at`.
  - Dùng làm cache: cùng `input_fp` trong 24h thì trả lại kết quả cũ, trừ khi `force=1`.
  - Cột phản hồi (chỉ cho `draft`): `final_text`, `final_fingerprint`, `matched_at`, `edit_ratio numeric` (0 = gửi nguyên văn, 1 = khác hoàn toàn), `outcome` (`sent_as_is` < 0.05 ≤ `light_edit` < 0.4 ≤ `heavy_edit`; `ignored` khi hết 15 phút mà không có tin nào).
- **`prompt_variants`**: `prompt_version` PK, `task`, `template_notes`, `weight int` (0 = tắt), `created_at`. Lúc generate, chọn ngẫu nhiên có trọng số trong các variant đang bật của task `draft`.

## 5. Luồng xử lý

### 5.1 n8n (I/O)
| Workflow | Trigger | Việc làm |
|---|---|---|
| `ingest-crisp` | Webhook Crisp cấp website (`message:send`, `message:received`, `session:set_segments`, `session:set_state`, `session:set_email`) cho cả 2 website. Hook cấp website không được Crisp ký, nên bảo vệ bằng đường dẫn ngẫu nhiên (plugin hiện không có scope cho plugin hook có chữ ký) | Lọc event → RPC `ingest_event` |
| `backfill-crisp` | Chạy tay (90 ngày) + mỗi đêm (reconcile 24h) | Duyệt conversation/messages qua API → RPC `ingest_event` |
| `refresh-conversation` | Webhook (gọi từ Edge Function) | Lấy messages + meta mới nhất của 1 session → RPC `ingest_event`, trả `ok` |
| `jira-link-indexer` | Webhook note Crisp có link Jira | Ghi `jira_links`, lấy issue + comment → `jira_issues`/`jira_comments`, ghi `jira_keys` vào meta Crisp, đăng note xác nhận |
| `jira-sync` | Mỗi 5 phút + Jira webhook | Lấy issue đang link đã thay đổi → upsert `jira_issues`/`jira_comments` → gọi Edge Function `jira-diff` |
| `helpdesk-sync` | Mỗi đêm | Lấy bài helpdesk từng workspace → upsert `helpdesk_articles` khi `content_hash` đổi → gọi Edge Function để embed bài đã đổi |
| `post-note` | Webhook (gọi từ Edge Function) | Đăng private note vào Crisp |
| `jira-attachment-proxy` | Giữ nguyên | Proxy file đính kèm Jira có ký chữ ký |

RPC `ingest_event` trong Postgres lo: upsert operator/conversation/message, chống trùng theo `fingerprint`, gắn `is_bot`, tự học `user_id` của bot từ nickname, cập nhật `last_customer_at` / `last_human_operator_at`, map segment → topic.

### 5.2 Edge Function `copilot`
Input: header `x-copilot-token`; body `website_id`, `session_id`, `action` (`check`|`handoff`|`generate`), `force`.

Bước chung: hash token → tìm operator → kiểm tra operator thuộc workspace → gọi n8n `refresh-conversation` (timeout 5s — đo thực tế ~3s, quá thì dùng DB và gắn `stale: true`) → dựng context từ DB.

- **`check`** (không AI): ticket đang link, status, comment tech mới kể từ `last_human_operator_at`, status có đổi kể từ mốc đó không, số tin khách chưa trả lời, topic hiện tại, profile sẽ dùng.
- **`handoff`**: hội thoại đã bỏ tin bot + Jira context → Gemini (`handoff`) → note có cấu trúc:
  - Vấn đề của khách · Đã làm gì · Đang tới đâu
  - Jira (status + cập nhật mới) · Đang chờ ai (khách / tech / CS) · Bước tiếp theo
  - Đăng note qua n8n, lưu `outputs`.
- **`generate`**:
  1. Topic: lấy từ `conversations.topic`; chưa có thì phân loại ngay (`classify`).
  2. Chọn profile theo thứ tự fallback.
  3. Embed câu hỏi gần nhất của khách → `match_cases` (90 ngày) + `match_helpdesk`.
  4. Gemini (`draft`): prompt gồm profile, Jira context (giữ logic đọc comment tech từ v4), case tương tự, đoạn helpdesk làm **nguồn ưu tiên cao nhất**, hội thoại. Chế độ `jira` / `jira_update` / `summary` như v4.
  5. Gemini (`verify`): draft + đoạn helpdesk → JSON `warnings[]`, mỗi cảnh báo chỉ ra chi tiết không có hoặc trái helpdesk, kèm `article_url`.
  6. Lưu `outputs` (kèm `prompt_version`), trả `{draft, warnings, output_id}` cho extension để điền vào ô Reply. Không đăng note.

### 5.3 Edge Function `jira-diff`
Được `jira-sync` gọi sau khi upsert. Với mỗi conversation có link tới issue thay đổi: so status và comment với mốc `last_human_operator_at` và `last_seen_*`. Có thay đổi và `jira_auto_note = true` thì soạn note tóm tắt cập nhật (template, không cần AI), gọi n8n `post-note`, rồi cập nhật `last_notified_at` / `last_seen_*`.

### 5.4 Job nền (pg_cron → Edge Function)
| Job | Lịch | Việc làm |
|---|---|---|
| `classify-topics` | Mỗi giờ | Conversation có tin mới mà chưa có topic từ segment → Gemini phân loại theo lô (≤ 20 conversation/request) vào `workspaces.topics` |
| `index-cases` | Mỗi 30 phút | Conversation mới resolve → Gemini tóm tắt (vấn đề, cách xử lý, tin cuối của CS) → embed → `cases` |
| `learn-profiles` | Mỗi đêm | Với mỗi CS × workspace: lấy tin của CS (không bot) 90 ngày, nhóm theo topic. Topic ≥ ngưỡng thì tạo profile riêng. Luôn cập nhật `_all`. Gemini rút văn phong + chọn ≤ 8 tin mẫu. Bỏ qua trường có `manual_override` |
| `cleanup` | Mỗi đêm | Xoá `messages`, `cases`, `outputs` cũ hơn 90 ngày |

### 5.5 Vòng phản hồi draft → tin gửi
- **Ghép**: trigger sau khi insert `messages` (operator, không bot, không note). Tìm `outputs` loại `draft` mới nhất của cùng `website_id` + `session_id` + `operator_id`, chưa ghép, tạo trong 15 phút gần nhất → ghi `final_text`, `final_fingerprint`, `matched_at`, `edit_ratio` (khoảng cách Levenshtein theo từ chia cho độ dài lớn hơn), `outcome`.
- **Hết hạn**: job `expire-drafts` (mỗi 15 phút) gắn `outcome = 'ignored'` cho draft quá 15 phút chưa ghép.
- **Đọc kết quả**: view `draft_feedback_stats` gom theo `prompt_version`, `topic`, `operator_id`, `website_id`: số draft, % `sent_as_is`/`light_edit`/`heavy_edit`/`ignored`, `edit_ratio` trung bình. Xem bằng SQL Editor, chưa cần dashboard.
- **Dùng lại**: `learn-profiles` ưu tiên `final_text` của draft `light_edit`/`heavy_edit` làm tin mẫu (đây là văn phong CS đã chỉnh).

### 5.6 Gọi Gemini (dùng chung)
Module `_shared/gemini.ts`: đọc `ai_config.models` theo task, thử lần lượt từng model. Gặp 429/5xx thì chuyển model tiếp theo. Ghi `ai_usage_log`. Hết chuỗi thì ném lỗi `AI_UNAVAILABLE`.

## 6. Giao diện: Crisp Plugin Widget + extension cầu nối

Nguyên tắc: mỗi phần chỉ làm việc mà phần kia không làm được. **Server (`outputs`) là nguồn sự thật duy nhất.** Extension không gọi mạng, không giữ trạng thái, không cần cấu hình.

```
app.crisp.chat (1 tab)
  Ô Reply ◄── content script top-frame (chèn chữ, kiểm tra session)
                  ▲ chrome.runtime qua background, cùng tab (frameId 0)
  Sidebar iframe (widget của mình) ◄── content script trong iframe (cầu nối postMessage)
                  │
                  ▼ HTTPS + x-copilot-token
            Edge Function copilot
```

### 6.1 Crisp Plugin Widget (sidebar)
- Plugin Crisp riêng (tái sử dụng plugin của v4, đổi URL iframe), cài trên cả 2 website. Trang widget host tĩnh trên **Netlify** (Supabase Storage/Edge Function không phục vụ `text/html` trên domain mặc định). File `_headers` của Netlify đặt `Content-Security-Policy: frame-ancestors https://app.crisp.chat` để chỉ Crisp nhúng được widget; extension match đúng domain Netlify này cho content script trong iframe.
- Lấy `website_id`, `session_id` bằng `$crisp.acquireData("conversation")`, operator bằng `$crisp.acquireData("operator")`.
- Không nhập token: widget gửi `crisp_token` (từ URL iframe) + `operator_id` (từ SDK). Ai trong workspace đã cài plugin, đang active, mở chat là dùng được.
- Khi mở: chạy `check`, hiện Jira (badge **MỚI**), số tin chưa trả lời, topic + profile.
- Nút: `✨ Soạn tin`, `↻ Soạn lại` (`force=1`), `📋 Handoff` (đăng note).
- Sau `generate`: hiện draft + ⚠ (link helpdesk) trong widget, rồi gửi lệnh chèn cho extension. Nút phụ: `Điền lại`, `Copy`.
- Luôn hiện "draft gần nhất" của conversation (lấy từ server), nên reload widget không mất draft.

### 6.2 Extension (MV3) — chỉ chèn chữ
- Content script **trong iframe widget** (match domain widget, `all_frames: true`): nhận `window.postMessage` từ trang widget, chuyển qua `chrome.runtime` tới background, background gửi tới top frame cùng tab (`frameId: 0`), rồi trả kết quả ngược lại.
- Content script **top frame** (`https://app.crisp.chat/*`): tìm ô Reply, chèn chữ như người gõ để editor Crisp nhận.
- Permissions tối thiểu: không `host_permissions` tới Supabase, không `storage` cho token.

### 6.3 Giao thức widget ↔ extension (`protocol: 1`)
| Message | Hướng | Nội dung |
|---|---|---|
| `copilot:ping` | widget → ext | `{protocol}` |
| `copilot:pong` | ext → widget | `{protocol, version}` |
| `copilot:insert` | widget → ext | `{request_id, output_id, session_id, text, mode: "auto" \| "replace" \| "append"}` |
| `copilot:insert_result` | ext → widget | `{request_id, status: "inserted" \| "session_mismatch" \| "not_empty" \| "duplicate" \| "composer_not_found"}` |

Trang widget chỉ chấp nhận message có `origin` khớp. Content script chỉ nhận message có `source === window` và `type` bắt đầu bằng `copilot:`.

### 6.4 Chốt chống bất đồng bộ
1. **Sai conversation**: top frame so `session_id` trong lệnh với URL đang mở. Khác thì `session_mismatch`, không chèn. Widget báo "Draft của chat khác đã sẵn sàng".
2. **Response muộn**: mỗi request widget có `request_id`. Response không khớp conversation/request hiện tại thì bỏ.
3. **Chèn hai lần**: top frame nhớ các `output_id` đã chèn trong tab. Gặp lại thì trả `duplicate`, trừ khi `mode` là `replace`/`append` do CS chủ động bấm "Điền lại".
4. **Ô Reply có chữ**: `mode: "auto"` + ô không rỗng thì trả `not_empty`. Widget hỏi **Thay thế / Chèn xuống cuối / Huỷ**.
5. **Không có hoặc lệch extension**: không nhận `pong` trong 1 giây thì chế độ Copy. `protocol` khác thì báo "Cập nhật extension" và dùng Copy.
6. **Sai người**: operator của token khác `acquireData("operator").user_id` thì widget cảnh báo.
7. **Không mất dữ liệu**: draft lưu ở `outputs` trước khi chèn. Ghép draft với tin gửi chạy ở server (5.5), không phụ thuộc UI.

## 7. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Sai token / operator không thuộc workspace | 401/403, widget hiện ô nhập lại token |
| Không chèn được vào ô Reply (`composer_not_found`, Crisp đổi giao diện) | Widget hiện nút Copy, báo CS dán bằng Ctrl+V |
| Ô Reply đang có chữ CS gõ dở | Widget hỏi Thay thế / Chèn cuối / Huỷ (6.4) |
| Refresh n8n > 5s | Dùng DB, `stale: true` |
| `AI_UNAVAILABLE` | Widget báo hết quota hoặc AI lỗi. `check` vẫn chạy |
| Verify lỗi | Trả draft, gắn nhãn "chưa đối chiếu helpdesk" |
| Post note (handoff) lỗi | Widget vẫn hiện nội dung để copy |
| Webhook ingest bị miss | Reconcile mỗi đêm. Ingest idempotent |
| Prompt injection trong chat | Chat được đưa vào prompt như dữ liệu. Không có hành động tự động nào ra ngoài ngoài private note |

## 8. Testing

- **Edge Functions** (`deno test`, mock Gemini + n8n), fixture hội thoại ẩn danh:
  - lọc Mary/Zoey và note 🤖
  - tính `last_human_operator_at` và tin chưa trả lời
  - phát hiện status/comment Jira mới
  - chọn profile theo thứ tự fallback
  - chọn topic (segment trước, AI sau)
  - chuỗi fallback model khi 429
  - parse JSON verify
- **SQL**: test RPC `ingest_event` (chống trùng, `is_bot`, học bot `user_id`, map segment → topic), `match_cases` lọc 90 ngày.
- **n8n**: chạy thử với 1 conversation test trên mỗi workspace.

## 9. Triển khai

1. Tạo schema + RPC trên Supabase, nhập 2 dòng `workspaces`.
2. Dựng các workflow n8n I/O, chạy backfill 90 ngày.
3. Deploy Edge Functions + pg_cron, chạy `learn-profiles` lần đầu, xem lại vài profile.
4. Đổi URL widget trong plugin Crisp + cài extension cho bản thân + 1–2 CS, sau đó mở cho cả team. Tắt workflow v4.

## 10. Cấu trúc repo

```
supabase/
  migrations/
  functions/
    _shared/          (gemini.ts, context.ts, profile.ts, auth.ts, n8n.ts)
    copilot/
    jira-diff/
    learn-profiles/
    classify-topics/
    index-cases/
    embed-helpdesk/
n8n/                  (workflow JSON export)
widget/               (trang widget sidebar, deploy Netlify)
extension/            (Chrome extension MV3, chỉ chèn chữ)
legacy/               (4 workflow v4 hiện tại)
docs/superpowers/specs/
```

## 11. Rủi ro / điểm cần xác minh khi build

- **Crisp Helpdesk API**: xác nhận endpoint lấy danh sách và nội dung bài theo locale với token plugin hiện có.
- **DOM ô soạn tin của Crisp**: selector và cách chèn chữ phải được dò trên `app.crisp.chat` thật. Có thể hỏng khi Crisp cập nhật giao diện (đã có fallback Copy). Cần xác nhận thêm: content script với `all_frames` chạy được trong iframe widget của Crisp, và iframe widget được reload hay nhận dữ liệu mới khi CS đổi conversation.
- **Tên model Gemini free tier** có thể đổi. Đã gom vào `ai_config` nên chỉ cần sửa dữ liệu.
- **Quota free tier** không công bố cố định. Theo dõi qua `ai_usage_log`.
