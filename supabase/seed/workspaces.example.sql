-- Chạy trong Supabase SQL Editor sau khi `npm run db:push`. Thay giá trị trong <>.
insert into public.workspaces (website_id, name, jira_project, helpdesk_locale, topics, default_profile)
values
  ('<WEBSITE_ID_APP_A>', '<App A>', '<JIRA_PROJECT_A>', 'en',
   '[{"key":"billing","label":"Billing","segments":["billing","payment"]},
     {"key":"bug","label":"Bug","segments":["bug"]},
     {"key":"setup","label":"Setup","segments":["setup","onboarding"]}]',
   '{"tone":"thân thiện, lịch sự, ngắn gọn","pronoun_self":"mình","pronoun_customer":"bạn"}'),
  ('<WEBSITE_ID_APP_B>', '<App B>', '<JIRA_PROJECT_B>', 'en',
   '[{"key":"billing","label":"Billing","segments":["billing"]}]',
   '{"tone":"thân thiện, lịch sự, ngắn gọn"}');
