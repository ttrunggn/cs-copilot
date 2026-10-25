-- Backfill GRANT cho hai bảng tạo ở migrations 014/015, theo quy tắc Supabase
-- có hiệu lực 30/10/2026: bảng mới trong schema public KHÔNG còn được tự động
-- cấp quyền cho các role Data API — thiếu GRANT tường minh thì service_role
-- chạm vào bảng là permission denied (dù role này bypass RLS).
--
-- 014 (conversation_sentiment) và 015 (csat_survey_sends) đều đã bật RLS,
-- còn thiếu đúng GRANT mức bảng cho service_role — role Edge Functions dùng
-- qua Data API (supabase/functions/_shared/db.ts đọc/ghi cả hai bảng).
-- Migration này CHỈ bổ sung grant: không đổi RLS, không thêm policy, không
-- cấp quyền cho anon/authenticated (giữ nguyên thiết kế của repo: chỉ
-- service_role chạm dữ liệu, anon/authenticated bị RLS deny-all).
-- Cả hai bảng dùng khóa chính dạng text nên không cần grant trên sequence.
-- Căn cứ: docs/grants-audit-2026-10-24.md (PR #17).

grant select, insert, update, delete on public.conversation_sentiment to service_role;
grant select, insert, update, delete on public.csat_survey_sends to service_role;
