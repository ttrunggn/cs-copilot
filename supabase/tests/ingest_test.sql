begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

insert into public.workspaces (website_id, name, topics) values
  ('ws1', 'App A',
   '[{"key":"billing","label":"Billing","segments":["billing","payment"]},
     {"key":"bug","label":"Bug","segments":["bug"]}]');

create function pg_temp.msg(fp int, frm text, ts bigint, content jsonb,
                            uid text default null, nick text default null, typ text default 'text')
returns jsonb language sql as $$
  select jsonb_build_object(
    'website_id', 'ws1',
    'event', case when frm = 'user' then 'message:send' else 'message:received' end,
    'data', jsonb_strip_nulls(jsonb_build_object(
      'session_id', 's1', 'fingerprint', fp, 'from', frm, 'type', typ,
      'content', content, 'timestamp', ts,
      'user', case when uid is null and nick is null then null
                   else jsonb_strip_nulls(jsonb_build_object('user_id', uid, 'nickname', nick)) end)))
$$;

create function pg_temp.conv() returns public.conversations language sql as $$
  select * from public.conversations where website_id = 'ws1' and session_id = 's1'
$$;

-- 1-4: tin khách + chống trùng
select lives_ok($$ select public.ingest_event(pg_temp.msg(1, 'user', 1760500000000, '"hi"')) $$, 'ingests customer message');
select is((select count(*)::int from public.messages where session_id = 's1'), 1, 'stores one message');
do $$ begin perform public.ingest_event(pg_temp.msg(1, 'user', 1760500000000, '"hi"')); end $$;
select is((select count(*)::int from public.messages where session_id = 's1'), 1, 'dedupes by fingerprint');
select is((pg_temp.conv()).last_customer_at, to_timestamp(1760500000), 'sets last_customer_at');

-- 5-6: bot Mary được nhận diện và học user_id
do $$ begin perform public.ingest_event(pg_temp.msg(2, 'operator', 1760500001000, '"I am Mary"', 'bot-mary', 'mary')); end $$;
select ok((select is_bot from public.messages where fingerprint = '2'), 'Mary is a bot');
select is((select bot_identifiers->'learned'->>'mary' from public.workspaces where website_id = 'ws1'), 'bot-mary', 'learns Mary user_id');

-- 7: người thật tên Mary (khác user_id) không phải bot
do $$ begin perform public.ingest_event(pg_temp.msg(3, 'operator', 1760500003000, '"hello"', 'human-mary', 'Mary')); end $$;
select ok(not (select is_bot from public.messages where fingerprint = '3'), 'human named Mary is not a bot');

-- 8: bot đổi nickname vẫn là bot
do $$ begin perform public.ingest_event(pg_temp.msg(4, 'operator', 1760500004000, '"hi again"', 'bot-mary', 'Mary v2')); end $$;
select ok((select is_bot from public.messages where fingerprint = '4'), 'learned bot id stays a bot after rename');

-- 9-11: CS người thật
do $$ begin perform public.ingest_event(pg_temp.msg(5, 'operator', 1760500005000, '"Chào bạn"', 'op-lan', 'Lan')); end $$;
select ok(not (select is_bot from public.messages where fingerprint = '5'), 'Lan is human');
select is((pg_temp.conv()).last_human_operator_at, to_timestamp(1760500005), 'sets last_human_operator_at');
select ok(exists (select 1 from public.operator_workspaces where crisp_user_id = 'op-lan' and website_id = 'ws1'), 'registers Lan in workspace');

-- 12-13: note của copilot (🤖) là bot và không đổi mốc
do $$ begin perform public.ingest_event(pg_temp.msg(6, 'operator', 1760500006000, '"🤖 Draft: ..."', 'op-lan', 'Lan', 'note')); end $$;
select ok((select is_bot from public.messages where fingerprint = '6'), 'copilot note flagged as bot');
select is((pg_temp.conv()).last_human_operator_at, to_timestamp(1760500005), 'note does not move last_human_operator_at');

-- 14-15: tin cũ đến muộn không làm lùi mốc
do $$ begin perform public.ingest_event(pg_temp.msg(7, 'operator', 1760499999000, '"old"', 'op-minh', 'Minh')); end $$;
select is((pg_temp.conv()).last_human_operator_at, to_timestamp(1760500005), 'older message does not move timestamp back');
select is((pg_temp.conv()).assigned_operator, 'op-lan', 'older message does not change assigned_operator');

-- 16-17: tin operator không có user object
select lives_ok($$ select public.ingest_event(pg_temp.msg(8, 'operator', 1760500008000, '"from mobile"')) $$, 'operator message without user object');
select is((pg_temp.conv()).last_human_operator_at, to_timestamp(1760500008), 'anonymous operator message counts as human');

-- 18: nội dung file
do $$ begin perform public.ingest_event(pg_temp.msg(9, 'user', 1760500009000, '{"name":"a.png","url":"https://x/a.png"}', null, null, 'file')); end $$;
select is((select content from public.messages where fingerprint = '9'), '[file] a.png https://x/a.png', 'renders file content');

-- 19-22: segment -> topic
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_segments","data":{"session_id":"s1","segments":["Payment","vip"]}}'); end $$;
select is((pg_temp.conv()).topic, 'billing', 'maps segment to topic (case-insensitive)');
select is((pg_temp.conv()).topic_source, 'segment', 'topic_source = segment');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_segments","data":{"session_id":"s1","segments":["vip"]}}'); end $$;
select is((pg_temp.conv()).topic, null::text, 'clears segment topic when no segment matches');
update public.conversations set topic = 'bug', topic_source = 'ai' where session_id = 's1';
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_segments","data":{"session_id":"s1","segments":["vip"]}}'); end $$;
select is((pg_temp.conv()).topic, 'bug', 'keeps AI topic when segments do not match');

-- 23-24: state
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_state","data":{"session_id":"s1","state":"resolved"}}'); end $$;
select ok((pg_temp.conv()).resolved_at is not null, 'resolved sets resolved_at');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_state","data":{"session_id":"s1","state":"unresolved"}}'); end $$;
select ok((pg_temp.conv()).resolved_at is null, 'reopen clears resolved_at');

-- 25: danh sách operator
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"operators:list","data":{"operators":[{"type":"operator","details":{"user_id":"op-hoa","email":"hoa@x.io","first_name":"Hoa","last_name":"Tran"}}]}}'); end $$;
select ok(exists (select 1 from public.operators o join public.operator_workspaces w using (crisp_user_id)
                  where o.crisp_user_id = 'op-hoa' and o.email = 'hoa@x.io' and w.website_id = 'ws1'), 'operators:list upserts operator + membership');

-- 26: workspace lạ
select throws_ok($$ select public.ingest_event('{"website_id":"nope","event":"message:send","data":{"session_id":"x"}}') $$,
                 'P0001', 'unknown website_id nope', 'rejects unknown workspace');

-- 27: batch
select is(public.ingest_events(jsonb_build_array(pg_temp.msg(10, 'user', 1760500010000, '"a"'), pg_temp.msg(11, 'user', 1760500011000, '"b"'))),
          2, 'ingest_events returns count');

select * from finish();
rollback;
