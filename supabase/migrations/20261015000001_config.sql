create table public.workspaces (
  website_id text primary key,
  name text not null,
  jira_project text,
  helpdesk_locale text not null default 'en',
  topics jsonb not null default '[]'::jsonb,
  bot_identifiers jsonb not null default '{"nicknames": ["Mary", "Zoey"], "learned": {}}'::jsonb,
  cs_jira_authors text[] not null default '{}',
  default_profile jsonb not null default '{}'::jsonb,
  min_conversations_per_topic int not null default 5,
  jira_auto_note boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.operators (
  crisp_user_id text primary key,
  email text,
  display_name text,
  jira_display_name text,
  copilot_token_hash text unique,
  updated_at timestamptz not null default now()
);

create table public.operator_workspaces (
  crisp_user_id text not null references public.operators on delete cascade,
  website_id text not null references public.workspaces on delete cascade,
  active boolean not null default true,
  primary key (crisp_user_id, website_id)
);

create table public.ai_config (
  task text primary key,
  models text[] not null
);

insert into public.ai_config (task, models) values
  ('draft',        array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('verify',       array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('handoff',      array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('classify',     array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('learn',        array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('case_summary', array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('embed',        array['gemini-embedding-2']);

create table public.ai_usage_log (
  day date not null,
  model text not null,
  task text not null,
  calls int not null default 0,
  errors_429 int not null default 0,
  primary key (day, model, task)
);

create table public.agent_profiles (
  crisp_user_id text not null,
  website_id text not null references public.workspaces on delete cascade,
  topic text not null,                       -- '_all' = profile chung
  tone text,
  pronoun_self text,
  pronoun_customer text,
  use_emoji boolean,
  signature text,
  sample_messages text[] not null default '{}',
  style_notes text,
  conversations_used int not null default 0,
  learned_at timestamptz,
  manual_override jsonb,
  primary key (crisp_user_id, website_id, topic)
);

alter table public.workspaces enable row level security;
alter table public.operators enable row level security;
alter table public.operator_workspaces enable row level security;
alter table public.ai_config enable row level security;
alter table public.ai_usage_log enable row level security;
alter table public.agent_profiles enable row level security;

-- Cấp token mới cho CS (token cũ mất hiệu lực). Plaintext chỉ trả về một lần.
create function public.issue_copilot_token(p_crisp_user_id text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := encode(gen_random_bytes(24), 'hex');
begin
  update operators set copilot_token_hash = encode(digest(v_token, 'sha256'), 'hex'), updated_at = now()
  where crisp_user_id = p_crisp_user_id;
  if not found then raise exception 'unknown operator %', p_crisp_user_id; end if;
  return v_token;
end $$;
revoke execute on function public.issue_copilot_token(text) from public, anon, authenticated;
