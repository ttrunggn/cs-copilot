begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

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

-- 25b-25e: membership theo danh sách operator của Crisp
select ok(not (select active from public.operator_workspaces where crisp_user_id = 'op-lan' and website_id = 'ws1'),
          'member seen only in messages stays inactive until operators:list confirms');
select ok((select active from public.operator_workspaces where crisp_user_id = 'op-hoa' and website_id = 'ws1'),
          'operators:list activates listed operators');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"operators:list","data":{"operators":[{"details":{"user_id":"op-lan","email":"lan@x.io"}}]}}'); end $$;
select ok(not (select active from public.operator_workspaces where crisp_user_id = 'op-hoa' and website_id = 'ws1'),
          'operator removed from Crisp is deactivated');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"operators:list","data":{"operators":[]}}'); end $$;
select ok((select active from public.operator_workspaces where crisp_user_id = 'op-lan' and website_id = 'ws1'),
          'empty operators list (API hiccup) does not deactivate everyone');

-- 26: workspace lạ
select throws_ok($$ select public.ingest_event('{"website_id":"nope","event":"message:send","data":{"session_id":"x"}}') $$,
                 'P0001', 'unknown website_id nope', 'rejects unknown workspace');

-- 27: batch
select is(public.ingest_events(jsonb_build_array(pg_temp.msg(10, 'user', 1760500010000, '"a"'), pg_temp.msg(11, 'user', 1760500011000, '"b"'))),
          2, 'ingest_events returns count');

-- 28-34: custom data của phiên (migration 020) — session riêng s-cd, độc lập với dãy trên
create function pg_temp.conv_cd() returns public.conversations language sql as $$
  select * from public.conversations where website_id = 'ws1' and session_id = 's-cd'
$$;
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_data","data":{"session_id":"s-cd","data":{"shopify_domain":"shop-a.myshopify.com","tc_plan":"Cross-Border"}}}'); end $$;
select is((pg_temp.conv_cd()).custom_data,
          '{"shopify_domain":"shop-a.myshopify.com","tc_plan":"Cross-Border"}'::jsonb,
          'set_data with pairs under data.data creates custom_data');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_data","data":{"session_id":"s-cd","data":{"shopify_domain":"shop-b.myshopify.com","tc_status":"true"}}}'); end $$;
select is((pg_temp.conv_cd()).custom_data,
          '{"shopify_domain":"shop-b.myshopify.com","tc_plan":"Cross-Border","tc_status":"true"}'::jsonb,
          'second set_data merges: overwrites same key, keeps others, adds new keys');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_data","data":{"session_id":"s-cd","shopify_theme":"LIVE"}}'); end $$;
select is((pg_temp.conv_cd()).custom_data->>'shopify_theme', 'LIVE',
          'set_data pairs at top level of data also merge');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_data","data":{"session_id":"s-cd","data":{"tc_target_currencies":["EUR"],"nested":{"a":1},"tc_visits":3,"tc_trial":false}}}'); end $$;
select is((pg_temp.conv_cd()).custom_data,
          '{"shopify_domain":"shop-b.myshopify.com","tc_plan":"Cross-Border","tc_status":"true","shopify_theme":"LIVE","tc_visits":3,"tc_trial":false}'::jsonb,
          'non-scalar values (array/object) dropped, scalar number/boolean kept');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:meta","data":{"session_id":"s-cd","email":"a@b.c","nickname":"A","segments":[],"state":"unresolved","data":{"shopify_plan":"unlimited"}}}'); end $$;
select is((pg_temp.conv_cd()).custom_data->>'shopify_plan', 'unlimited',
          'session:meta (refresh shape, meta.data under data.data) merges too');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_segments","data":{"session_id":"s-cd","segments":["vip"]}}'); end $$;
select ok(not ((pg_temp.conv_cd()).custom_data ? 'segments') and not ((pg_temp.conv_cd()).custom_data ? 'session_id'),
          'structural keys (segments/session_id) never leak into custom_data');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"message:send","data":{"session_id":"s-cd","fingerprint":991,"from":"user","type":"text","content":"hi","timestamp":1760500020000}}'); end $$;
select is((pg_temp.conv_cd()).custom_data,
          '{"shopify_domain":"shop-b.myshopify.com","tc_plan":"Cross-Border","tc_status":"true","shopify_theme":"LIVE","tc_visits":3,"tc_trial":false,"shopify_plan":"unlimited"}'::jsonb,
          'message events leave custom_data unchanged');

-- 35-41: cách ly custom_data giữa các session — hai phiên s-iso-a / s-iso-b
-- set_data XEN KẼ thứ tự (A, B, rồi A ghi lần 2): mỗi phiên phải giữ đúng
-- domain và key riêng của mình, không key nào của phiên kia lọt sang.
create function pg_temp.conv_iso(p_sid text) returns public.conversations language sql as $$
  select * from public.conversations where website_id = 'ws1' and session_id = p_sid
$$;
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_data","data":{"session_id":"s-iso-a","data":{"shopify_domain":"iso-a.myshopify.com","tc_plan":"A-plan","only_a":"alpha"}}}'); end $$;
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_data","data":{"session_id":"s-iso-b","data":{"shopify_domain":"iso-b.myshopify.com","only_b":"beta"}}}'); end $$;
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_data","data":{"session_id":"s-iso-a","data":{"shopify_domain":"iso-a2.myshopify.com"}}}'); end $$;
select is((pg_temp.conv_iso('s-iso-a')).custom_data->>'shopify_domain', 'iso-a2.myshopify.com',
          'interleaved set_data: session A second write overwrites its own domain');
select is((pg_temp.conv_iso('s-iso-b')).custom_data->>'shopify_domain', 'iso-b.myshopify.com',
          'interleaved set_data: session B domain untouched by session A writes');
select is((pg_temp.conv_iso('s-iso-a')).custom_data,
          '{"shopify_domain":"iso-a2.myshopify.com","tc_plan":"A-plan","only_a":"alpha"}'::jsonb,
          'session A merges its own keys only — no key from session B leaks in');
select is((pg_temp.conv_iso('s-iso-b')).custom_data,
          '{"shopify_domain":"iso-b.myshopify.com","only_b":"beta"}'::jsonb,
          'session B merges its own keys only — no key from session A leaks in');

-- Phiên chưa từng có set_data/meta (chỉ có tin nhắn): custom_data vẫn {}.
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"message:send","data":{"session_id":"s-empty","fingerprint":992,"from":"user","type":"text","content":"hi","timestamp":1760500021000}}'); end $$;
select is((pg_temp.conv_iso('s-empty')).custom_data, '{}'::jsonb,
          'session without set_data/meta keeps empty custom_data {}');

-- session:meta kiểu refresh (dữ liệu ở meta.data → data.data) cũng khoá đúng
-- phiên: ghi cho B thì chỉ B đổi, A giữ nguyên từng key.
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:meta","data":{"session_id":"s-iso-b","email":"b@x.io","nickname":"B","segments":[],"state":"unresolved","data":{"shopify_domain":"iso-b-meta.myshopify.com","meta_only":"from-meta"}}}'); end $$;
select is((pg_temp.conv_iso('s-iso-b')).custom_data,
          '{"shopify_domain":"iso-b-meta.myshopify.com","only_b":"beta","meta_only":"from-meta"}'::jsonb,
          'session:meta (refresh shape) merges into its own session only');
select is((pg_temp.conv_iso('s-iso-a')).custom_data,
          '{"shopify_domain":"iso-a2.myshopify.com","tc_plan":"A-plan","only_a":"alpha"}'::jsonb,
          'session:meta for session B leaves session A custom_data unchanged');

select * from finish();
rollback;
