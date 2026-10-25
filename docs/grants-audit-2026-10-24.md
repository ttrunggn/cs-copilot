# Rà soát GRANT / RLS / Policy — Migrations 014, 015, 016

Ngày rà soát: 2026-10-24. Phạm vi: đúng 3 file migration dưới đây, kết luận chỉ dựa trên nội dung file (và ghi chú bối cảnh repo được đánh dấu riêng). Không sửa nội dung/logic của bất kỳ migration cũ nào.

- `20261022000014_sentiment.sql` (014)
- `20261022000015_csat.sql` (015)
- `20261022000016_note_format.sql` (016)

## Quy tắc đối chiếu (Supabase, hiệu lực 30/10/2026)

Từ 30/10/2026, bảng mới tạo trong schema được expose (như `public`) **không còn được tự động cấp quyền** cho các role dùng Data API (`anon`, `authenticated`, `service_role`) như trước. Muốn bảng dùng được qua Data API (PostgREST / supabase-js) thì migration phải có **GRANT tường minh**. Ba lớp kiểm soát cần phân biệt:

- **GRANT** — quyền ở mức bảng/cột cho từng role. Thiếu grant: role đó chạm vào bảng là `permission denied`, kể cả `service_role`.
- **RLS** (`enable row level security`) — bật thì mọi truy cập của `anon`/`authenticated` bị chặn theo policy; `service_role` bypass RLS nhưng **vẫn cần GRANT**.
- **Policy** — quy tắc dòng cho `anon`/`authenticated`. RLS đã bật mà không có policy nào = hai role đó bị từ chối toàn bộ (deny-all).

## Bối cảnh repo (ngoài phạm vi 3 file, để đọc kết quả cho đúng)

- Toàn bộ 23 migration hiện có **không có bất kỳ GRANT mức bảng nào**; GRANT duy nhất trong repo là `grant execute on function public.ingest_event(jsonb) to service_role` (002, lặp lại ở 004 và 020).
- Toàn bộ repo **không có bất kỳ `create policy` nào**; mọi bảng đều bật RLS rồi để trống policy — tức thiết kế hiện tại là "chỉ `service_role` (từ Edge Functions, qua Data API) được chạm vào dữ liệu", `anon`/`authenticated` bị deny-all bởi RLS. Đây là lựa chọn nhất quán của cả repo, không phải thiếu sót riêng của 014/015/016.
- Hệ quả theo quy tắc mới: phần **thật sự thiếu** ở các bảng mới là **GRANT cho `service_role`** — trước 30/10 quyền này đến từ mặc định của Supabase, sau 30/10 phải viết tường minh.

## Bảng tổng hợp

| Migration | Bảng | Loại thay đổi | GRANT | RLS | Policy | Kết luận |
|---|---|---|---|---|---|---|
| 014 | `public.conversation_sentiment` | Tạo mới | **Thiếu** | Đã bật | Không có | Cần bổ sung GRANT |
| 014 | `public.ai_config` | Chỉ `insert` dữ liệu mẫu (không đổi cấu trúc) | Không áp dụng | Không áp dụng | Không áp dụng | Đạt |
| 015 | `public.csat_survey_sends` | Tạo mới | **Thiếu** | Đã bật | Không có | Cần bổ sung GRANT |
| 016 | `public.agent_profiles` | Chỉ thêm cột `note_format` vào bảng có sẵn | Không phát sinh | Không phát sinh | Không phát sinh | Đạt |

## Chi tiết từng migration

### 014 — `20261022000014_sentiment.sql`

- Tạo bảng mới `public.conversation_sentiment` (PK `website_id, session_id`).
- Có `alter table public.conversation_sentiment enable row level security;` — **RLS: đạt**.
- **GRANT: thiếu.** File không có câu lệnh grant nào cho bảng này (cũng không có cho role nào khác). Bảng được Edge Functions đọc/ghi qua Data API bằng `service_role` (`supabase/functions/_shared/db.ts`), nên theo quy tắc 30/10/2026 cần grant tường minh cho `service_role`.
- **Policy: không có** — khớp thiết kế chung của repo (deny-all cho `anon`/`authenticated`). Không tính là thiếu sót riêng; chỉ trở thành việc phải làm nếu sau này mở bảng cho `authenticated`.
- Câu `insert into public.ai_config` chỉ nạp dữ liệu cấu hình vào bảng có sẵn, không tạo/sửa bảng — không phát sinh yêu cầu grant/RLS/policy trong file này.

### 015 — `20261022000015_csat.sql`

- Tạo bảng mới `public.csat_survey_sends` (PK `website_id, session_id`).
- Có `alter table public.csat_survey_sends enable row level security;` — **RLS: đạt**.
- **GRANT: thiếu**, hệt 014: không có grant nào trong file; bảng được Edge Functions đọc/ghi/xoá qua Data API bằng `service_role` nên cần grant tường minh theo quy tắc mới.
- **Policy: không có** — như 014, khớp thiết kế chung của repo, không tính là thiếu sót riêng.

### 016 — `20261022000016_note_format.sql`

- Chỉ có một câu `alter table public.agent_profiles add column note_format jsonb;` — **không tạo bảng mới, không đổi quyền truy cập**.
- Cột mới kế thừa nguyên trạng GRANT/RLS/policy của `agent_profiles` (bảng này được tạo ở migration 001, đã bật RLS tại đó).
- **Kết luận: đạt.** File này không phát sinh thiếu sót nào theo quy tắc 30/10/2026. (Việc `agent_profiles` — cũng như mọi bảng cũ khác — không có GRANT mức bảng là chuyện của các migration tạo bảng trước thời điểm quy tắc đổi; xem mục Bối cảnh. Nếu muốn xử lý toàn repo thì làm một migration backfill riêng, ngoài phạm vi rà soát này.)

## Cần bổ sung (làm ở migration MỚI, không sửa 014/015)

Tạo một migration mới (ví dụ `20261030000024_grants_backfill.sql`) chứa đúng các câu dưới đây. Cả hai bảng đều dùng PK dạng text (không có cột serial/identity) nên **không cần** grant trên sequence.

```sql
-- Backfill GRANT cho hai bảng tạo ở 014/015, theo quy tắc Supabase 30/10/2026:
-- bảng mới trong schema public không còn được tự cấp quyền cho Data API.

grant select, insert, update, delete on public.conversation_sentiment to service_role;
grant select, insert, update, delete on public.csat_survey_sends to service_role;

-- Chỉ thêm khi thật sự cần mở cho client đăng nhập (authenticated) — và khi đó
-- bắt buộc kèm policy, vì RLS đang bật và chưa có policy nào:
-- grant select on public.conversation_sentiment to authenticated;
-- create policy "..." on public.conversation_sentiment for select to authenticated using (...);
```

## Kết luận

- **014 và 015**: mỗi file thiếu đúng một thứ theo quy tắc mới — **GRANT tường minh cho `service_role`** trên bảng mới tạo. RLS đã bật đầy đủ; policy trống là chủ đích chung của repo. Cách sửa: một migration backfill mới như trên, không động vào file cũ.
- **016**: **đạt toàn bộ** trong phạm vi của nó (chỉ thêm cột, không tạo bảng, không đổi mặt bằng quyền).
- Từ nay, migration tạo bảng mới phải đủ 4 phần trong cùng một file (định nghĩa bảng + GRANT + RLS + policy khi cần) — dùng mẫu tại `supabase/templates/migration-template.sql`.
