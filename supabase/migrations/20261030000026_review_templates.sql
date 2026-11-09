-- Template xin review theo profile + link đích theo workspace.
--
-- Mô hình: GIỌNG theo profile (agent_profiles.review_template của chính CS,
-- chứa biến {{review_link}}), LINK theo workspace (workspaces.review_link) —
-- server thay biến khi trả về panel (supabase/functions/_shared/review.ts).
-- CS chưa học được template → panel dùng template mặc định CÓ GHI NGUỒN là
-- mặc định, không im lặng thay thế.
--
-- Seed cho workspace Transcy:
-- - review_link: trang Transcy trên Shopify App Store, biến thể WriteReviewModal
--   (mở thẳng form viết review). Đổi biến thể = sửa đúng một dòng này.
-- - review_template cho từng profile CS: giữ giọng riêng của CS đó, link
--   thay bằng biến {{review_link}}.
-- CS chưa đủ dữ liệu học → review_template giữ null, panel hiện
-- mặc định có ghi nhãn. Các workspace khác: review_link null → template
-- mặc định tự bỏ dòng link.
--
-- Chỉ thêm cột + seed dữ liệu: không đổi RLS/policy; cột mới trên hai bảng
-- đã có grant service_role (bảng agent_profiles/workspaces có từ trước
-- backfill grant ở 024) nên không phát sinh grant mới.

alter table public.workspaces
  add column if not exists review_link text;

alter table public.agent_profiles
  add column if not exists review_template text;

update public.workspaces
set review_link = 'https://apps.shopify.com/transcy-multiple-languages?ref=fireapps&utm_campaign=product_tc_camp3#modal-show=WriteReviewModal'
where website_id = 'f5733b35-0234-49e3-aca0-ed27b30b8ee1';

update public.agent_profiles
set review_template = $$Hi,

Just checking in to see if your issue has been resolved.

If you still need any assistance, please feel free to reply here and we'll be happy to help further. If everything is working well now and you're happy with our app and the support you received, we'd be grateful if you could spend 5 seconds leaving a review on the Shopify App Store. Your feedback is a huge motivation for us to keep improving

Below is the direct link:
{{review_link}}

Thanks so much$$
where crisp_user_id = '7a3af4dc-e79e-4535-aa25-b259e787b209'
  and website_id = 'f5733b35-0234-49e3-aca0-ed27b30b8ee1';

update public.agent_profiles
set review_template = $$Hi there,

Here's Anna again from Transcy team. I just want to check on how things are going since our previous support ^^

In case everything is okay, hopefully you can please spend 10 seconds leaving feedback for my little support 🤗

Your feedback means a lot to me and my team as well.

Below is the direct link:
{{review_link}}

I really appreciate your kind words <3$$
where crisp_user_id = '6f9339c4-3df9-43ba-867d-3cba2f9c8fff'
  and website_id = 'f5733b35-0234-49e3-aca0-ed27b30b8ee1';
