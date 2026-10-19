begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into public.workspaces (website_id, name) values ('ws-c', 'C');
insert into public.conversations (website_id, session_id) values ('ws-c', 's1');
insert into public.messages (website_id, session_id, fingerprint, "from", type, content, created_at) values
  ('ws-c', 's1', 'old', 'user', 'text', 'old', now() - interval '91 days'),
  ('ws-c', 's1', 'new', 'user', 'text', 'new', now() - interval '89 days');
insert into public.outputs (website_id, session_id, operator_id, kind, input_fp, content, created_at) values
  ('ws-c', 's1', 'op', 'draft', 'a', 'old', now() - interval '91 days'),
  ('ws-c', 's1', 'op', 'draft', 'b', 'new', now() - interval '1 day');
insert into public.cases (website_id, session_id, summary, embedding, resolved_at) values
  ('ws-c', 'c-old', 'old', array_fill(0.1, array[768])::vector, now() - interval '91 days'),
  ('ws-c', 'c-new', 'new', array_fill(0.1, array[768])::vector, now() - interval '5 days');

select ok((select (r->>'messages')::int >= 1 and (r->>'outputs')::int >= 1 and (r->>'cases')::int >= 1 from (select public.cleanup_old_data(90) r) x), 'reports deleted counts per table');
select is((select array_agg(content) from public.messages where website_id = 'ws-c'), array['new'], 'keeps messages within 90 days');
select is((select array_agg(content) from public.outputs where website_id = 'ws-c'), array['new'], 'keeps recent outputs');
select is((select array_agg(summary) from public.cases where website_id = 'ws-c'), array['new'], 'keeps recent cases');
select is(has_function_privilege('anon', 'public.cleanup_old_data(int)', 'execute'), false, 'anon cannot run cleanup');
select is((select count(*)::int from cron.job where jobname = 'copilot-cleanup'), 1, 'nightly cleanup is scheduled');

select * from finish();
rollback;
