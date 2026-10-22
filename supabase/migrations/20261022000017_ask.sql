-- Action "ask" (Hỏi tài liệu, board 3): trả lời câu hỏi của CS chỉ từ các bài
-- helpdesk truy hồi được, kèm nguồn. Cần một hàng ai_config riêng cho task
-- "ask" — dùng cùng danh sách model như các task văn bản khác (sentiment,
-- draft…): câu hỏi ngắn, cần model nhanh/rẻ, không cần model mạnh.

insert into public.ai_config (task, models) values
  ('ask', array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash'])
on conflict (task) do nothing;
