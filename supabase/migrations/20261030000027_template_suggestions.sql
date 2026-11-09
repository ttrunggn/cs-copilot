-- Gợi ý tối ưu template/draft:
-- customize NHƯNG TỐI ƯU theo cơ chế GỢI Ý — mẫu gốc của CS giữ nguyên,
-- panel hiện thẻ gợi ý kèm lý do dễ hiểu; CS tự quyết dùng hay không.
--
-- 1) agent_profiles.review_template_suggestion (jsonb {text, reason}):
--    bản tối ưu của CHÍNH template đã học của CS đó (text chứa biến
--    {{review_link}} như template gốc; server thay link theo workspace khi
--    trả về panel). reason viết tiếng Việt, chỉ đúng đoạn yếu. null = không
--    có gợi ý. CS bấm "Lưu làm mẫu mới" → server ghi bản gợi ý vào
--    review_template, xoá suggestion, và đánh dấu manual_override
--    .review_template_manual = true để các lần học lại không ghi đè.
-- 2) profile_style_samples: mẫu CS đã duyệt lưu từ luồng Draft ("Lưu làm
--    mẫu mới" trong popup Draft) — draft không phải template cố định nên
--    không ghi vào review_template; các mẫu này là đầu vào ưu tiên cho vòng
--    học profile về sau (học từ chính lựa chọn của CS, minh bạch).
-- 3) Seed gợi ý cho các profile đã có review_template (migration 026).

alter table public.agent_profiles
  add column if not exists review_template_suggestion jsonb;

-- Task AI riêng cho bước kiểm tra tối ưu draft (cùng họ model rẻ như verify;
-- mẫu theo migration 014 khi thêm task sentiment).
insert into public.ai_config (task, models) values
  ('polish', array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash'])
on conflict (task) do nothing;

create table public.profile_style_samples (
  id bigint generated always as identity primary key,
  crisp_user_id text not null,
  website_id text not null references public.workspaces on delete cascade,
  kind text not null check (kind in ('draft', 'review')),
  text text not null,
  created_at timestamptz not null default now()
);

alter table public.profile_style_samples enable row level security;

grant select, insert, update, delete on public.profile_style_samples to service_role;
grant usage, select on sequence public.profile_style_samples_id_seq to service_role;

update public.agent_profiles
set review_template_suggestion = jsonb_build_object(
  'text', $$Hi there,

Here's Anna again from the Transcy team. Just checking in to see how things have been going since we last spoke ^^

If everything is okay now, could you spend 10 seconds leaving a review of my support? 🤗 Your feedback means a lot to me and my team.

Below is the direct link:
{{review_link}}

I really appreciate it <3$$,
  'reason', $$Người bản xứ đọc vào sẽ hơi khựng ở hai chỗ: "since our previous support" nghe chưa tự nhiên, và "hopefully you can please spend 10 seconds leaving feedback for my little support" hơi lủng củng. Bản gợi ý sửa đúng hai chỗ đó và giữ nguyên giọng của bạn.$$
)
where crisp_user_id = '6f9339c4-3df9-43ba-867d-3cba2f9c8fff'
  and website_id = 'f5733b35-0234-49e3-aca0-ed27b30b8ee1'
  and review_template is not null;

update public.agent_profiles
set review_template_suggestion = jsonb_build_object(
  'text', $$Hi,

Just checking in to see if your issue has been resolved.

If you still need any assistance, please feel free to reply here and we'll be happy to help further.

If everything is working well now and you're happy with our app and the support you received, we'd be grateful if you could spend 5 seconds leaving a review on the Shopify App Store. Your feedback is a huge motivation for us to keep improving.

Below is the direct link:
{{review_link}}

Thanks so much$$,
  'reason', $$Mẫu đã khá chuẩn. Chỉ thiếu một dấu chấm ở cuối câu "keep improving" và một câu đang hơi dài. Bản gợi ý tách câu cho dễ đọc, giữ nguyên ý và giọng của bạn.$$
)
where crisp_user_id = '7a3af4dc-e79e-4535-aa25-b259e787b209'
  and website_id = 'f5733b35-0234-49e3-aca0-ed27b30b8ee1'
  and review_template is not null;
