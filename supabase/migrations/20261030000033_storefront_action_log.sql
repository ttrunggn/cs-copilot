-- Nhật ký thao tác ghi Storefront Watch từ panel (Take case / Fix /
-- Dismiss / Mở lại) : thay vì trông vào email
-- digest (chỉ gửi khi có bug mới), mọi cú click trong panel được ghi
-- thành một dòng ở đây ngay khi thao tác thành công, rồi workflow n8n
-- "Storefront Report" kéo các dòng chưa báo (reported_at is null) lên
-- Google Sheet "Storefront Watch — Report" và ack lại.
--
-- Ghi log là best-effort ở phía action: thao tác lên SW đã thành công
-- thì log lỗi KHÔNG được làm hỏng kết quả trả cho CS (server nuốt lỗi
-- ghi log sau khi đã trace). reported_at chỉ được đặt khi n8n xác nhận
-- đã append lên Sheet xong — append lỗi thì lần kéo sau lấy lại đúng
-- các dòng đó, không mất, không trùng ngoài ý muốn.

create table public.storefront_action_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  website_id text not null references public.workspaces on delete cascade,
  session_id text not null,
  operator_name text,
  act text not null check (act in ('acknowledge', 'fixed', 'dismiss', 'undo')),
  shop text not null,
  fingerprint text not null,
  title text,
  severity text,
  locale text,
  page text,
  reason text,
  note text,
  crisp_url text not null,
  console_url text,
  reported_at timestamptz
);

create index storefront_action_log_unreported_idx
  on public.storefront_action_log (created_at)
  where reported_at is null;

alter table public.storefront_action_log enable row level security;

grant select, insert, update on public.storefront_action_log to service_role;
