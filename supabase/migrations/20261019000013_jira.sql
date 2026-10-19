-- Jira (spec 4.5): chỉ tin link do CS dán trong private note. Trigger trên messages ghi nhận link, n8n + Edge Function
-- jira-sync lo phần đồng bộ và đăng note.

create table public.jira_links (
  website_id text not null,
  session_id text not null,
  issue_key text not null check (issue_key ~ '^[A-Z][A-Z0-9_]+-[0-9]+$'),
  url text not null,
  created_by text,
  created_at timestamptz not null default now(),
  active boolean not null default true,
  silent_baseline boolean not null default false, -- link cũ từ lịch sử: lần sync đầu chỉ ghi mốc, không đăng note
  last_seen_status text,
  last_seen_comment_at timestamptz,
  last_notified_at timestamptz,
  primary key (website_id, session_id, issue_key),
  foreign key (website_id, session_id) references public.conversations on delete cascade
);
create index jira_links_active on public.jira_links (issue_key) where active;

create table public.jira_issues (
  issue_key text primary key,
  summary text,
  status text,
  status_category text,
  assignee text,
  updated_at timestamptz,
  status_changed_at timestamptz,
  synced_at timestamptz not null default now()
);

create table public.jira_comments (
  id text primary key,
  issue_key text not null,
  author text,
  role text not null check (role in ('tech', 'cs', 'bot')),
  body_text text not null default '',
  created_at timestamptz not null
);
create index jira_comments_issue_time on public.jira_comments (issue_key, created_at);

alter table public.jira_links enable row level security;
alter table public.jira_issues enable row level security;
alter table public.jira_comments enable row level security;

-- Ghi nhận các issue key trong một note. p_silent = true: link cũ (không kích hoạt lại, sync đầu không đăng note).
create function public.link_jira_keys(p_website_id text, p_session_id text, p_content text, p_created_by text, p_silent boolean)
returns int language plpgsql security definer set search_path = public as $$
declare v_project text; v_count int := 0; m text[]; v_rows int;
begin
  select jira_project into v_project from workspaces where website_id = p_website_id;
  for m in select regexp_matches(coalesce(p_content, ''),
      'https?://([a-z0-9-]+\.atlassian\.net)/(?:browse/|[^\s<>)]*[?&]selectedIssue=)([A-Z][A-Z0-9_]+-[0-9]+)', 'g') loop
    continue when v_project is not null and split_part(m[2], '-', 1) <> v_project;
    if p_silent then
      insert into jira_links (website_id, session_id, issue_key, url, created_by, silent_baseline)
      values (p_website_id, p_session_id, m[2], 'https://' || m[1] || '/browse/' || m[2], p_created_by, true)
      on conflict do nothing;
    else
      insert into jira_links (website_id, session_id, issue_key, url, created_by)
      values (p_website_id, p_session_id, m[2], 'https://' || m[1] || '/browse/' || m[2], p_created_by)
      on conflict (website_id, session_id, issue_key) do update set active = true;
    end if;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;
  return v_count;
end $$;

-- Note của CS người thật (không phải note hệ thống 🔗🔔🤖⚠️) có link Jira → theo dõi ticket đó.
create function public.track_jira_links()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.content !~ '^\s*(🔗|🔔|🤖|⚠️)' then
    perform link_jira_keys(new.website_id, new.session_id, new.content, new.operator_id, false);
  end if;
  return null;
end $$;
create trigger messages_track_jira after insert on public.messages
for each row when (new."from" = 'operator' and new.type = 'note' and not new.is_bot and new.content like '%atlassian.net%')
execute function public.track_jira_links();

-- Link đã có trong lịch sử chat (trước khi có trigger): ghi nhận im lặng.
create function public.backfill_jira_links(p_website_id text)
returns int language plpgsql security definer set search_path = public as $$
declare r record; v_count int := 0;
begin
  for r in select session_id, content, operator_id from messages
           where website_id = p_website_id and "from" = 'operator' and type = 'note' and not is_bot
             and content like '%atlassian.net%' and content !~ '^\s*(🔗|🔔|🤖|⚠️)'
           order by created_at loop
    v_count := v_count + link_jira_keys(p_website_id, r.session_id, r.content, r.operator_id, true);
  end loop;
  return v_count;
end $$;

revoke execute on function public.link_jira_keys(text, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.track_jira_links() from public, anon, authenticated;
revoke execute on function public.backfill_jira_links(text) from public, anon, authenticated;
