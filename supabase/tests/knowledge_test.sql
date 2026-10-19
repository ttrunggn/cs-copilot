begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into public.workspaces (website_id, name) values ('ws-k', 'K');

-- 1-3: cấu hình
select has_column('public', 'messages', 'content_en', 'messages can hold an English translation');
select is((select count(*)::int from public.ai_config where task = 'translate'), 1, 'translate task configured');
select is((select weight from public.prompt_variants where prompt_version = 'draft-v1'), 100, 'default draft variant seeded');

-- 4-6: helpdesk_stale_articles
insert into public.helpdesk_articles (website_id, locale, article_id, title, url, content_md, content_hash, source_updated_at) values
  ('ws-k', 'en', 'a1', 'T1', 'https://h/a1', 'body1', 'h1', to_timestamp(1)),
  ('ws-k', 'en', 'a2', 'T2', 'https://h/a2', 'body2', 'h2', to_timestamp(1));
select set_eq(
  $$ select * from public.helpdesk_stale_articles('ws-k', 'en', '[{"article_id":"a1","updated_at":2000000},{"article_id":"a3","updated_at":1000}]') $$,
  array['a1', 'a3']::text[], 'new and changed articles are stale');
select is((select count(*)::int from public.helpdesk_articles where article_id = 'a2'), 0, 'article missing from list is deleted');
select is((select count(*)::int from public.helpdesk_stale_articles('ws-k', 'en', '[]')), 0, 'empty list returns nothing');

-- 7-9: upsert + replace chunks
select is(public.upsert_helpdesk_articles('ws-k', 'en',
  '[{"article_id":"a3","title":"T3","url":"https://h/a3","category":"Getting Started","content":"body3","updated_at":1000}]'),
  1, 'upserts one article');
select is((select content_hash from public.helpdesk_articles where article_id = 'a3'), md5('T3' || E'\n' || 'body3'), 'content hash = md5(title\ncontent)');
select is((select category from public.helpdesk_articles where article_id = 'a3'), 'Getting Started', 'stores category');
select lives_ok(format($$ select public.replace_helpdesk_chunks(%s, %L, %L::jsonb) $$,
  (select id from public.helpdesk_articles where article_id = 'a3'),
  (select content_hash from public.helpdesk_articles where article_id = 'a3'),
  jsonb_build_array(jsonb_build_object('text', 'T3 chunk', 'embedding', array_fill(0.1, array[768])::vector::text))::text),
  'replace chunks');
select is((select embedded_hash from public.helpdesk_articles where article_id = 'a3'),
          (select content_hash from public.helpdesk_articles where article_id = 'a3'), 'replace_helpdesk_chunks marks article embedded');
select is((select embedded_hash is null from public.helpdesk_articles where article_id = 'a1'), true, 'other articles still pending');

-- 13-14: match
select is((select title from public.match_helpdesk('ws-k', array_fill(0.1, array[768])::vector, 1)), 'T3', 'closest chunk first');
insert into public.cases (website_id, session_id, topic, summary, embedding, resolved_at) values
  ('ws-k', 's-new', 'billing', 'recent', array_fill(0.1, array[768])::vector, now() - interval '10 days'),
  ('ws-k', 's-old', 'billing', 'old', array_fill(0.1, array[768])::vector, now() - interval '100 days');
select is((select array_agg(summary) from public.match_cases('ws-k', array_fill(0.1, array[768])::vector, 5)), array['recent'], 'cases older than 90 days are excluded');

-- 15-16: usage log
select public.log_ai_usage('m-test', 'draft', true);
select public.log_ai_usage('m-test', 'draft', false);
select is((select array[calls, errors_429] from public.ai_usage_log where model = 'm-test' and task = 'draft' and day = current_date), array[2, 1], 'usage counted');
select has_table('public', 'outputs', 'outputs table exists');

select * from finish();
rollback;
