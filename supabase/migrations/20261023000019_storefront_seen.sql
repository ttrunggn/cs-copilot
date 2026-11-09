-- Watermark Storefront Watch: fingerprint nào đã từng hiện trên panel của
-- từng workspace. Action storefront đọc mốc này để chia 3 trạng thái:
-- fingerprint chưa có trong bảng = Mới; đã có = Đã xác
-- nhận (nhóm Đang xử lý được suy từ hội thoại, không lưu ở đây). Mỗi lần
-- fetch thành công, server upsert các fingerprint hiện tại: insert giữ
-- first_seen_at lần đầu, conflict chỉ cập nhật last_seen_at.

create table public.storefront_seen (
  website_id text not null references public.workspaces on delete cascade,
  fingerprint text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (website_id, fingerprint)
);

alter table public.storefront_seen enable row level security;
