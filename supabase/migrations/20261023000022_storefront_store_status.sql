-- Bản chụp trạng thái Storefront Watch theo từng store (job đối chiếu nền
-- storefront_sweep ghi; action check đọc). Job lấy các domain duy nhất từ
-- custom_data.shopify_domain của các conversation gần đây thuộc workspace
-- của chính Transcy rồi gọi find_store từng domain và UPSERT vào bảng này —
-- chạy lại ghi đè bản chụp, không nhân dữ liệu (idempotent theo PK).
--
-- Panel dùng bản chụp để: (1) quyết định cổng Storefront tức thì trong
-- workspace Transcy (domain có dữ kiện SW thì không cần ticket Jira nữa —
-- xem enabledModules ở _shared/jira.ts); (2) hiện badge số lỗi đang mở của
-- store ngay tại khối Issue logs trước cả khi module nạp chi tiết.
-- Chi tiết findings KHÔNG lưu ở đây — vẫn lấy trực tiếp từ MCP khi module
-- mở (storefront_seen giữ nguyên vai trò watermark chia 3 trạng thái).

create table public.storefront_store_status (
  website_id text not null references public.workspaces on delete cascade,
  shop text not null,
  watched boolean not null default false,
  open_critical int not null default 0,
  open_high int not null default 0,
  open_medium int not null default 0,
  open_low int not null default 0,
  open_total int not null default 0,
  worst_severity text,
  last_good_check text,
  fetched_at timestamptz not null default now(),
  primary key (website_id, shop)
);

alter table public.storefront_store_status enable row level security;
