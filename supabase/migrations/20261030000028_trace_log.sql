-- Bảng truy vết (tracing) cho copilot — Ethan chốt 2026-10-26: "làm gì
-- cũng cần truy vết để tracing". Trước giờ lỗi production chỉ xem được qua
-- log Supabase (chỉ chủ tài khoản mở được) hoặc ảnh chụp panel; từ nay mỗi
-- request qua handler ghi 1 dòng timing (action + tổng thời gian), lỗi ghi
-- thêm 1 dòng error (nguyên văn message), các chặng đắt (sync Jira nền,
-- gọi Storefront Watch) ghi timing riêng theo stage. Nhờ đó tra được cả
-- LỖI lẫn ĐIỂM CHẬM bằng truy vấn DB, không cần chờ ai chụp ảnh.
--
-- Ghi qua service_role (Edge Functions), đọc cũng qua service_role. RLS bật
-- và không policy cho anon/authenticated: bảng nội bộ, không lộ ra ngoài.
-- Code ghi log luôn nuốt lỗi (bảng chưa tồn tại / ghi hỏng không được làm
-- gãy nghiệp vụ) nên migration này chạy trước hay sau deploy code đều an
-- toàn.

create table if not exists public.trace_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  website_id text,
  session_id text,
  action text,
  kind text not null,
  stage text,
  duration_ms integer,
  message text,
  detail jsonb
);

create index if not exists trace_log_created_idx on public.trace_log (created_at desc);
create index if not exists trace_log_session_idx on public.trace_log (website_id, session_id, created_at desc);

alter table public.trace_log enable row level security;

grant select, insert on public.trace_log to service_role;
