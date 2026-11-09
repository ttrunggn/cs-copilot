-- Mốc theo dõi riêng của email digest Storefront Watch (action nội bộ
-- storefront_digest ghi): sau mỗi đợt quét của SW, store nào có bug MỚI
-- thì cả team nhận đúng 1 email (tiêu đề "Storefront Watch Weekly Scan",
-- mỗi store một dòng domain + link Crisp).
--
-- Tách hẳn khỏi hai bảng sẵn có, không dùng chung:
-- - storefront_seen là mốc Mới/Đã xác nhận CỦA PANEL: CS mở panel là
--   finding thành "đã thấy" — dùng chung sẽ xoá tín hiệu bug mới của
--   email trước khi job kịp gửi.
-- - storefront_store_status là bản chụp cho panel (sweep ghi đè mỗi lần
--   chạy), không giữ được tập fingerprint đã báo.
--
-- state: mốc "Last good check" (nguyên văn find_store, dạng YYYY-MM-DD)
-- gần nhất digest đã xử lý cho từng store. Chưa có dòng = store chưa có
-- mốc nền: lần chạy đầu chỉ ghi nền (findings đang mở + mốc hiện tại),
-- KHÔNG báo — email chỉ chứa bug mới của các đợt sau.
-- findings: các fingerprint digest đã tính cho store (đã nằm trong mốc
-- nền hoặc đã báo). Đợt quét mới = last good check đổi; bug mới =
-- fingerprint đang mở mà chưa có trong bảng này. Mốc + findings của một
-- store chỉ nâng SAU KHI email gửi thành công — gửi lỗi thì lần chạy sau
-- tính lại đúng đợt đó, không bỏ sót, không báo trùng ngoài ý muốn.

create table public.storefront_digest_state (
  website_id text not null references public.workspaces on delete cascade,
  shop text not null,
  last_good_check text,
  updated_at timestamptz not null default now(),
  primary key (website_id, shop)
);

create table public.storefront_digest_findings (
  website_id text not null references public.workspaces on delete cascade,
  shop text not null,
  fingerprint text not null,
  first_seen_at timestamptz not null default now(),
  primary key (website_id, shop, fingerprint)
);

alter table public.storefront_digest_state enable row level security;
alter table public.storefront_digest_findings enable row level security;
