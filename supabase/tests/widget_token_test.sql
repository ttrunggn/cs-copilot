begin;
create extension if not exists pgtap with schema extensions;
select plan(2);
select has_column('public', 'workspaces', 'crisp_widget_token_hash', 'workspaces stores the Crisp widget token hash');
insert into public.workspaces (website_id, name, crisp_widget_token_hash) values ('ws-wt', 'W', 'abc');
select throws_ok($$ insert into public.workspaces (website_id, name, crisp_widget_token_hash) values ('ws-wt2', 'W2', 'abc') $$,
                 '23505', null, 'widget token hash is unique per workspace');
select * from finish();
rollback;
