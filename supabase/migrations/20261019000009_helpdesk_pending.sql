-- Bài helpdesk có chunk cũ hoặc chưa có chunk (embed-helpdesk đọc view này qua service role).
create view public.helpdesk_pending_articles with (security_invoker = true) as
select id, website_id, title, content_md, content_hash
from public.helpdesk_articles
where embedded_hash is distinct from content_hash;

revoke all on public.helpdesk_pending_articles from anon, authenticated;
