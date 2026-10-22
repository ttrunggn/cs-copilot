-- Format private note học theo từng CS (từ note cũ type='note' của chính CS đó),
-- lưu ở dòng "_all" của agent_profiles. Chỉ là đặc điểm trình bày (thứ tự/nhãn mục,
-- ngôn ngữ, kiểu liệt kê, dòng đầu/ký tên) — nội dung note vẫn do HANDOFF_SCHEMA quyết.
-- null = CS chưa đủ note để học (dưới ngưỡng) → dùng template cố định như trước.

alter table public.agent_profiles add column note_format jsonb;
