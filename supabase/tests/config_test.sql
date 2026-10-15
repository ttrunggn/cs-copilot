begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

select has_table('public', 'workspaces', 'workspaces exists');
select has_table('public', 'operators', 'operators exists');
select has_table('public', 'operator_workspaces', 'operator_workspaces exists');
select has_table('public', 'ai_config', 'ai_config exists');
select has_table('public', 'ai_usage_log', 'ai_usage_log exists');
select has_table('public', 'agent_profiles', 'agent_profiles exists');

select is((select count(*)::int from public.ai_config), 7, 'ai_config seeded with 7 tasks');
select is((select models[1] from public.ai_config where task = 'draft'), 'gemini-3.5-flash-lite', 'draft uses flash-lite first');

insert into public.workspaces (website_id, name) values ('ws-t', 'T');
select is((select bot_identifiers from public.workspaces where website_id = 'ws-t'),
          '{"nicknames": ["Mary", "Zoey"], "learned": {}}'::jsonb, 'bot defaults to Mary/Zoey');

insert into public.operators (crisp_user_id, display_name) values ('op-t', 'T');
create temp table issued as select public.issue_copilot_token('op-t') as token;
select is((select length(token) from issued), 48, 'token is 48 hex chars');
select is((select copilot_token_hash from public.operators where crisp_user_id = 'op-t'),
          (select encode(extensions.digest(token, 'sha256'), 'hex') from issued), 'stores sha256 of token');

select is((select bool_and(relrowsecurity) from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('workspaces','operators','operator_workspaces','ai_config','ai_usage_log','agent_profiles')),
          true, 'RLS enabled on all config tables');

select * from finish();
rollback;
