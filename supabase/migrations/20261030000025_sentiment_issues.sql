-- Thêm cột issues cho conversation_sentiment : signals (trích nguyên văn lời khách)
-- không hợp làm thẻ "Vấn đề của khách" (tin cập nhật tiến độ cũng sẽ thành
-- issue), nên lớp phân tích sinh issues riêng: mỗi issue là một câu phát biểu vấn đề (tiếng
-- Việt, AI tổng hợp) kèm trích ngắn làm bằng chứng, lưu dạng jsonb
-- [{summary, evidence}]. signals giữ nguyên vai trò tín hiệu trong thẻ tâm
-- trạng, không còn bị dùng làm issue.
--
-- Migration này CHỈ thêm cột có default: không đổi dữ liệu cũ (dòng cũ lấy
-- issues = []), không đổi RLS/policy, không cần grant mới (grant mức bảng cho
-- service_role đã có từ migration 024 — thêm cột không phát sinh quyền mới).

alter table public.conversation_sentiment
  add column if not exists issues jsonb not null default '[]'::jsonb;
