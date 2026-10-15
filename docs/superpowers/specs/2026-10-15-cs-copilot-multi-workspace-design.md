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

### Ngoài phạm vi
- Tự gửi tin cho khách (copilot chỉ tạo private note).
- Handoff hàng loạt cuối shift (handoff chỉ chạy khi CS bấm cho từng chat).
- Dashboard / báo cáo.
- Quy trình rollout cấp công ty.

### Tiêu chí thành công
- CS ở cả 2 workspace dùng cùng một widget, mọi thứ tự phân theo `website_id`.
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
                     Widget sidebar Crisp
```

**Nguyên tắc phân vai**
- Credential Crisp và Jira **chỉ nằm trong n8n**. Supabase không gọi trực tiếp Crisp/Jira mà gọi webhook n8n.
- Edge Functions chỉ đọc dữ liệu đã có trong DB (cộng một lần refresh qua n8n), nên chạy nhanh và test được.
- Key Gemini nằm trong Supabase secrets.
- n8n gọi Supabase bằng service role key. Edge Function gọi n8n bằng header secret dùng chung (`N8N_SHARED_SECRET`).

## 4. Data model

Mọi bảng nghiệp vụ đều có `website_id`.

### 4.1 Cấu hình
- **`workspaces`**: `website_id` PK, `name`, `jira_project`, `widget_secret`, `helpdesk_locale`, `topics jsonb` (`[{key, label, segments: []}]`), `bot_identifiers jsonb` (`{nicknames: ["Mary","Zoey"], user_ids: []}`), `cs_jira_authors text[]`, `default_profile jsonb`, `min_conversations_per_topic int default 5`, `jira_auto_note bool default true`.
- **`operators`**: `crisp_user_id` PK, `email`, `display_name`, `jira_display_name`.
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

### 4.6 Output
- **`outputs`**: `id`, `website_id`, `session_id`, `operator_id`, `kind` (`draft`|`handoff`), `input_fp`, `content`, `warnings jsonb` (`[{claim, reason, article_url}]`), `profile_used`, `model`, `created_at`.
  - Dùng làm cache: cùng `input_fp` trong 24h thì trả lại kết quả cũ, trừ khi `force=1`.

## 5. Luồng xử lý

### 5.1 n8n (I/O)
| Workflow | Trigger | Việc làm |
|---|---|---|
| `ingest-crisp` | Webhook Crisp (`message:send`, `message:received`, `session:set_segments`, `session:set_state`, `session:set_email`) cho cả 2 website | Chuẩn hoá payload → RPC `ingest_event` |
| `backfill-crisp` | Chạy tay (90 ngày) + mỗi đêm (reconcile 24h) | Duyệt conversation/messages qua API → RPC `ingest_event` |
| `refresh-conversation` | Webhook (gọi từ Edge Function) | Lấy messages + meta mới nhất của 1 session → RPC `ingest_event`, trả `ok` |
| `jira-link-indexer` | Webhook note Crisp có link Jira | Ghi `jira_links`, lấy issue + comment → `jira_issues`/`jira_comments`, ghi `jira_keys` vào meta Crisp, đăng note xác nhận |
| `jira-sync` | Mỗi 5 phút + Jira webhook | Lấy issue đang link đã thay đổi → upsert `jira_issues`/`jira_comments` → gọi Edge Function `jira-diff` |
| `helpdesk-sync` | Mỗi đêm | Lấy bài helpdesk từng workspace → upsert `helpdesk_articles` khi `content_hash` đổi → gọi Edge Function để embed bài đã đổi |
| `post-note` | Webhook (gọi từ Edge Function) | Đăng private note vào Crisp |
| `jira-attachment-proxy` | Giữ nguyên | Proxy file đính kèm Jira có ký chữ ký |

RPC `ingest_event` trong Postgres lo: upsert operator/conversation/message, chống trùng theo `fingerprint`, gắn `is_bot`, tự học `user_id` của bot từ nickname, cập nhật `last_customer_at` / `last_human_operator_at`, map segment → topic.

### 5.2 Edge Function `copilot`
Input: `website_id`, `session_id`, `operator_id`, `secret`, `action` (`check`|`handoff`|`generate`), `force`.

Bước chung: kiểm tra secret của workspace → kiểm tra operator thuộc workspace → gọi n8n `refresh-conversation` (timeout 3s, quá thì dùng DB và gắn `stale: true`) → dựng context từ DB.

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
  6. Đăng note (draft + ⚠) qua n8n, lưu `outputs`, trả về widget.

### 5.3 Edge Function `jira-diff`
Được `jira-sync` gọi sau khi upsert. Với mỗi conversation có link tới issue thay đổi: so status và comment với mốc `last_human_operator_at` và `last_seen_*`. Có thay đổi và `jira_auto_note = true` thì soạn note tóm tắt cập nhật (template, không cần AI), gọi n8n `post-note`, rồi cập nhật `last_notified_at` / `last_seen_*`.

### 5.4 Job nền (pg_cron → Edge Function)
| Job | Lịch | Việc làm |
|---|---|---|
| `classify-topics` | Mỗi giờ | Conversation có tin mới mà chưa có topic từ segment → Gemini phân loại theo lô (≤ 20 conversation/request) vào `workspaces.topics` |
| `index-cases` | Mỗi 30 phút | Conversation mới resolve → Gemini tóm tắt (vấn đề, cách xử lý, tin cuối của CS) → embed → `cases` |
| `learn-profiles` | Mỗi đêm | Với mỗi CS × workspace: lấy tin của CS (không bot) 90 ngày, nhóm theo topic. Topic ≥ ngưỡng thì tạo profile riêng. Luôn cập nhật `_all`. Gemini rút văn phong + chọn ≤ 8 tin mẫu. Bỏ qua trường có `manual_override` |
| `cleanup` | Mỗi đêm | Xoá `messages`, `cases`, `outputs` cũ hơn 90 ngày |

### 5.5 Gọi Gemini (dùng chung)
Module `_shared/gemini.ts`: đọc `ai_config.models` theo task, thử lần lượt từng model. Gặp 429/5xx thì chuyển model tiếp theo. Ghi `ai_usage_log`. Hết chuỗi thì ném lỗi `AI_UNAVAILABLE`.

## 6. Widget

- Một file HTML cho cả 2 workspace. Đọc `website_id`, `session_id`, operator từ ngữ cảnh widget Crisp. Secret theo workspace.
- Khi mở: chạy `check`, hiện thẻ Jira (badge **MỚI**), số tin chưa trả lời, topic + profile đang dùng.
- Nút: `Tóm tắt / Handoff`, `Soạn tin`, `Soạn lại`.
- Kết quả: nội dung + nút Copy, danh sách ⚠ có link helpdesk, nhãn khi `stale` hoặc chưa verify được.

## 7. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Sai secret / operator không thuộc workspace | 401, widget báo lỗi cấu hình |
| Refresh n8n > 3s | Dùng DB, `stale: true` |
| `AI_UNAVAILABLE` | Widget báo hết quota hoặc AI lỗi. `check` vẫn chạy |
| Verify lỗi | Trả draft, gắn nhãn "chưa đối chiếu helpdesk" |
| Post note lỗi | Vẫn trả nội dung cho widget để copy |
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
4. Bật widget cho bản thân + 1–2 CS, sau đó mở cho cả team. Tắt workflow v4.

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
widget/               (widget.html)
legacy/               (4 workflow v4 hiện tại)
docs/superpowers/specs/
```

## 11. Rủi ro / điểm cần xác minh khi build

- **Crisp Helpdesk API**: xác nhận endpoint lấy danh sách và nội dung bài theo locale với token plugin hiện có.
- **Ngữ cảnh widget Crisp**: xác nhận widget nhận được `operator user_id` (v4 đang truyền `operator_id` qua query, giữ cách này nếu không có cách tốt hơn).
- **Tên model Gemini free tier** có thể đổi. Đã gom vào `ai_config` nên chỉ cần sửa dữ liệu.
- **Quota free tier** không công bố cố định. Theo dõi qua `ai_usage_log`.
