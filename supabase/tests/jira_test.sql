begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into public.workspaces (website_id, name, jira_project) values ('ws-j', 'J', 'TNT');
insert into public.conversations (website_id, session_id) values ('ws-j', 's1'), ('ws-j', 's2');

create function pg_temp.note(sid text, content text, typ text default 'note', bot boolean default false)
returns void language sql as $$
  insert into public.messages (website_id, session_id, fingerprint, "from", type, operator_id, is_bot, content, created_at)
  values ('ws-j', sid, md5(random()::text), 'operator', typ, 'op-casey', bot, content, now())
$$;

select pg_temp.note('s1', '**TC_2610_94 - pending DEV** <https://firegroup.atlassian.net/browse/TNT-9184>');
select is((select array[issue_key, url, created_by] from public.jira_links where session_id = 's1'),
          array['TNT-9184', 'https://firegroup.atlassian.net/browse/TNT-9184', 'op-casey'], 'CS note with a Jira link creates a tracked link');
select is((select active and not silent_baseline from public.jira_links where session_id = 's1'), true, 'new link is active and announces itself');

select pg_temp.note('s1', 'see https://firegroup.atlassian.net/jira/software/projects/TNT/boards/1?selectedIssue=TNT-9190');
select ok(exists (select 1 from public.jira_links where issue_key = 'TNT-9190'), 'board link with selectedIssue is recognised');

select pg_temp.note('s2', 'https://firegroup.atlassian.net/browse/ABC-1');
select is((select count(*)::int from public.jira_links where session_id = 's2'), 0, 'other Jira projects are ignored');

select pg_temp.note('s2', '🔗 ĐÃ THEO DÕI JIRA · TNT-1 https://firegroup.atlassian.net/browse/TNT-1');
select pg_temp.note('s2', '🤖 note https://firegroup.atlassian.net/browse/TNT-2', 'note', true);
select pg_temp.note('s2', 'https://firegroup.atlassian.net/browse/TNT-3', 'text');
select is((select count(*)::int from public.jira_links where session_id = 's2'), 0, 'system notes, bot notes and customer-facing texts are ignored');

update public.jira_links set active = false where issue_key = 'TNT-9184';
select pg_temp.note('s1', 'again https://firegroup.atlassian.net/browse/TNT-9184');
select is((select active from public.jira_links where issue_key = 'TNT-9184'), true, 're-pasting a stopped ticket reactivates it');

-- link cũ trong lịch sử: ghi nhận im lặng
insert into public.messages (website_id, session_id, fingerprint, "from", type, operator_id, is_bot, content, created_at)
values ('ws-j', 's2', 'hist', 'operator', 'note', 'op-rowan', false, 'https://firegroup.atlassian.net/browse/TNT-5000', now() - interval '10 days');
delete from public.jira_links where issue_key = 'TNT-5000';
select is(public.backfill_jira_links('ws-j'), 1, 'backfill finds historical links');
select is((select silent_baseline from public.jira_links where issue_key = 'TNT-5000'), true, 'backfilled links take a silent baseline');

select is(has_function_privilege('anon', 'public.backfill_jira_links(text)', 'execute'), false, 'anon cannot backfill');
select has_table('public', 'jira_comments', 'jira_comments exists');

select * from finish();
rollback;
