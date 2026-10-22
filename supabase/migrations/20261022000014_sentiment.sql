-- Sentiment/mood của khách theo từng conversation, tính trong Edge Function
-- (thay webhook analyze-mood của workflow survey trên n8n).
-- Cache theo input_fp (dấu vân tay tin nhắn): tin mới thì fp đổi, tự tính lại.

insert into public.ai_config (task, models) values
  ('sentiment', array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash'])
on conflict (task) do nothing;

create table public.conversation_sentiment (
  website_id text not null references public.workspaces on delete cascade,
  session_id text not null,
  input_fp text not null,
  score int not null check (score between 0 and 100),
  mood text not null check (mood in ('frustrated','confused','neutral','satisfied','happy')),
  urgency text not null check (urgency in ('low','medium','high')),
  confidence numeric not null default 0.5,
  summary text not null default '',
  signals jsonb not null default '[]'::jsonb,
  model text,
  updated_at timestamptz not null default now(),
  primary key (website_id, session_id)
);

alter table public.conversation_sentiment enable row level security;
