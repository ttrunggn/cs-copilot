-- ════════════════════════════════════════════════════════════════════════════
-- TEMPLATE MIGRATION — cs-copilot
--
-- Sao chép file này thành một migration mới trong supabase/migrations/ với tên
-- dạng YYYYMMDDHHMMSS_mo_ta.sql rồi thay toàn bộ các placeholder <...>.
-- File này cố ý nằm NGOÀI thư mục migrations/ để `supabase db push` không
-- nhặt nó chạy như một migration thật.
--
-- QUY TẮC SUPABASE CÓ HIỆU LỰC 30/10/2026:
-- Bảng mới trong schema public (schema được expose) KHÔNG còn được tự động
-- cấp quyền cho các role của Data API (anon / authenticated / service_role).
-- Thiếu GRANT tường minh = bảng không dùng được qua Data API (permission
-- denied), kể cả với service_role. Vì vậy mọi migration tạo bảng PHẢI đủ
-- 4 phần trong CÙNG MỘT FILE: (1) định nghĩa bảng, (2) GRANT, (3) bật RLS,
-- (4) POLICY (khi mở cho anon/authenticated).
--
-- QUY ƯỚC REPO: mọi thay đổi đi qua branch + pull request, không push thẳng
-- master; chạy test local trước khi mở PR.
-- ════════════════════════════════════════════════════════════════════════════

-- ── (1) ĐỊNH NGHĨA BẢNG ─────────────────────────────────────────────────────
-- Ghi chú trên đầu file: migration này làm gì, vì sao (theo lệ của repo).
-- Bảng thuộc workspace thì luôn có website_id + khóa về public.workspaces.

create table public.<ten_bang> (
  website_id text not null references public.workspaces on delete cascade,
  <cot> <kieu_du_lieu> not null,
  created_at timestamptz not null default now(),
  primary key (website_id, <cot_khoa>)
);

-- Index phụ nếu cần truy vấn theo cột khác:
-- create index <ten_bang>_<cot>_idx on public.<ten_bang> (<cot>);

-- ── (2) GRANT — bắt buộc theo quy tắc 30/10/2026 ────────────────────────────
-- service_role là role Edge Functions dùng qua Data API: cần đủ quyền thao
-- tác dữ liệu. Thiếu dòng này, function chạm vào bảng sẽ permission denied.

grant select, insert, update, delete on public.<ten_bang> to service_role;

-- Bảng có cột serial/identity thì phải grant thêm sequence:
-- grant usage, select on sequence public.<ten_bang>_<cot>_seq to service_role;

-- CHỈ mở khi thật sự cần — mặc định của repo là KHÔNG cấp cho anon/authenticated
-- (RLS bật + không policy = hai role này bị từ chối toàn bộ). Nếu cấp thì giữ
-- tối thiểu quyền và bắt buộc kèm policy ở phần (4):
-- grant select on public.<ten_bang> to authenticated;

-- ── (3) RLS — luôn bật cho mọi bảng mới ─────────────────────────────────────

alter table public.<ten_bang> enable row level security;

-- ── (4) POLICY — chỉ khi đã mở cho anon/authenticated ở phần (2) ────────────
-- service_role bypass RLS nên không cần policy. anon/authenticated thì RLS
-- không có policy = không đọc/ghi được dòng nào, kể cả khi đã có GRANT.
-- Bỏ comment và thay điều kiện thật khi dùng; điều kiện theo lệ của repo là
-- khớp website_id của workspace mà người dùng thuộc về.

-- create policy "<ten_bang>_select_own_workspace"
--   on public.<ten_bang> for select to authenticated
--   using (<dieu_kien_khop_workspace>);

-- create policy "<ten_bang>_write_own_workspace"
--   on public.<ten_bang> for all to authenticated
--   using (<dieu_kien_khop_workspace>)
--   with check (<dieu_kien_khop_workspace>);
