-- 029: Chuyển nhà cung cấp AI từ Gemini sang OpenAI.
-- Sinh text: gpt-6-luna (client ghim reasoning_effort=none). Embed: text-embedding-3-small
-- với dimensions=768 nên cột vector(768) giữ nguyên; vector cũ của Gemini KHÔNG dùng
-- lẫn được — sau khi áp migration này phải chạy scripts/reembed-openai.ts nhúng lại
-- helpdesk_chunks + cases trước khi bật traffic.
update public.ai_config
set models = array['gpt-6-luna']
where task in ('draft', 'verify', 'handoff', 'classify', 'translate', 'learn', 'case_summary', 'sentiment', 'ask', 'polish');

update public.ai_config
set models = array['text-embedding-3-small']
where task = 'embed';
