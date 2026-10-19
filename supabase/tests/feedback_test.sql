begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into public.workspaces (website_id, name) values ('ws-f', 'F');
insert into public.conversations (website_id, session_id)
select 'ws-f', 's' || i from generate_series(1, 7) i;

-- Mỗi kịch bản một session; draft tạo lúc T0 = 1 giờ trước.
insert into public.outputs (website_id, session_id, operator_id, kind, input_fp, content, prompt_version, created_at)
select 'ws-f', 's' || i, 'op1', 'draft', 'fp', d, case when i = 7 then 'v-test' else 'v-other' end, now() - interval '1 hour'
from (values (1, 'Hi there, please reinstall the app'), (2, 'a b c d e'), (3, 'x'), (4, 'x'), (5, 'x'), (6, 'x'), (7, 'x')) v(i, d);

create function pg_temp.send(sid text, content text, after interval, op text default 'op1', typ text default 'text', bot boolean default false)
returns void language sql as $$
  insert into public.messages (website_id, session_id, fingerprint, "from", type, operator_id, is_bot, content, created_at)
  values ('ws-f', sid, md5(random()::text), 'operator', typ, op, bot, content, now() - interval '1 hour' + after)
$$;
create function pg_temp.out(sid text) returns public.outputs language sql as $$
  select * from public.outputs where website_id = 'ws-f' and session_id = sid
$$;

select pg_temp.send('s1', 'hi there, please reinstall the app', interval '2 minutes');
select pg_temp.send('s2', 'totally different words here now', interval '2 minutes');
select pg_temp.send('s3', 'x', interval '20 minutes');
select pg_temp.send('s4', 'x', interval '2 minutes', bot => true);
select pg_temp.send('s5', 'x', interval '2 minutes', typ => 'note');
select pg_temp.send('s6', 'x', interval '2 minutes', op => 'op2');

select is(public.word_edit_ratio('Hi there friend', 'hi there friend'), 0::numeric, 'case-insensitive identical = 0');
select is(public.word_edit_ratio('a b c d', 'a b x d'), 0.25::numeric, 'one substitution in four words');
select is(public.word_edit_ratio('', ''), 0::numeric, 'both empty = 0');
select is((pg_temp.out('s1')).outcome, 'sent_as_is', 'verbatim send matches as sent_as_is');
select is((pg_temp.out('s1')).final_text, 'hi there, please reinstall the app', 'final text stored');
select is((pg_temp.out('s2')).outcome, 'heavy_edit', 'rewritten send is heavy_edit');
select is((pg_temp.out('s3')).matched_at, null, 'message after 15 minutes does not match');
select is((pg_temp.out('s4')).matched_at, null, 'bot message does not match');
select is((pg_temp.out('s5')).matched_at, null, 'note does not match');
select is((pg_temp.out('s6')).matched_at, null, 'other operator does not match');
select is((select ignored_pct from public.draft_feedback_stats where prompt_version = 'v-test'), 100::numeric, 'unmatched old draft counts as ignored');

select is(has_function_privilege('anon', 'public.word_edit_ratio(text, text)', 'execute'), false, 'anon cannot call word_edit_ratio');
select * from finish();
rollback;
