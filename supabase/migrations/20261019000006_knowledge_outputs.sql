create extension if not exists vector with schema extensions;

-- Bản dịch tiếng Anh của tin khách (null = chưa dịch). Bản gốc giữ ở content.
alter table public.messages add column content_en text;

insert into public.ai_config (task, models) values
  ('translate', array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash'])
on conflict (task) do nothing;

-- Helpdesk: chỉ bài published, n8n đồng bộ hằng đêm.
create table public.helpdesk_articles (
  id bigint generated always as identity primary key,
  website_id text not null references public.workspaces on delete cascade,
  locale text not null,
  article_id text not null,
  title text not null,
  url text not null,
  category text,
  content_md text not null default '',
  content_hash text not null,
  embedded_hash text,
  source_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (website_id, locale, article_id)
);

create table public.helpdesk_chunks (
  article_pk bigint not null references public.helpdesk_articles on delete cascade,
  chunk_idx int not null,
  text text not null,
  embedding extensions.vector(768) not null,
  primary key (article_pk, chunk_idx)
);

create table public.cases (
  id bigint generated always as identity primary key,
  website_id text not null references public.workspaces on delete cascade,
  session_id text not null,
  topic text,
  summary text not null,
  resolution text,
  final_reply text,
  embedding extensions.vector(768) not null,
  resolved_at timestamptz not null,
  unique (website_id, session_id)
);

create table public.prompt_variants (
  prompt_version text primary key,
  task text not null,
  template_notes text,
  weight int not null default 0 check (weight >= 0),
  created_at timestamptz not null default now()
);
insert into public.prompt_variants (prompt_version, task, template_notes, weight) values ('draft-v1', 'draft', null, 100);

create table public.outputs (
  id bigint generated always as identity primary key,
  website_id text not null references public.workspaces on delete cascade,
  session_id text not null,
  operator_id text not null,
  kind text not null check (kind in ('draft', 'handoff')),
  input_fp text not null,
  content text not null,
  warnings jsonb not null default '[]'::jsonb,
  verified boolean,
  helpdesk_matches int,
  topic text,
  profile_used text,
  model text,
  prompt_version text,
  created_at timestamptz not null default now(),
  -- vòng phản hồi (chỉ draft)
  final_text text,
  final_fingerprint text,
  matched_at timestamptz,
  edit_ratio numeric,
  outcome text check (outcome in ('sent_as_is', 'light_edit', 'heavy_edit', 'ignored'))
);
create index outputs_lookup on public.outputs (website_id, session_id, operator_id, kind, created_at desc);

alter table public.helpdesk_articles enable row level security;
alter table public.helpdesk_chunks enable row level security;
alter table public.cases enable row level security;
alter table public.prompt_variants enable row level security;
alter table public.outputs enable row level security;

create function public.log_ai_usage(p_model text, p_task text, p_is_429 boolean)
returns void language sql security definer set search_path = public, extensions as $$
  insert into ai_usage_log (day, model, task, calls, errors_429)
  values (current_date, p_model, p_task, 1, p_is_429::int)
  on conflict (day, model, task) do update
    set calls = ai_usage_log.calls + 1, errors_429 = ai_usage_log.errors_429 + excluded.errors_429
$$;

-- p_list = [{article_id, updated_at (ms)}] của các bài published. Xoá bài không còn trong list, trả bài cần tải lại.
create function public.helpdesk_stale_articles(p_website_id text, p_locale text, p_list jsonb)
returns setof text language plpgsql security definer set search_path = public, extensions as $$
begin
  if jsonb_array_length(coalesce(p_list, '[]'::jsonb)) = 0 then return; end if;
  delete from helpdesk_articles a
  where a.website_id = p_website_id and a.locale = p_locale
    and not exists (select 1 from jsonb_array_elements(p_list) x where x->>'article_id' = a.article_id);
  return query
    select x->>'article_id'
    from jsonb_array_elements(p_list) x
    left join helpdesk_articles a
      on a.website_id = p_website_id and a.locale = p_locale and a.article_id = x->>'article_id'
    where a.id is null or a.source_updated_at is null
       or a.source_updated_at < to_timestamp((x->>'updated_at')::double precision / 1000);
end $$;

create function public.upsert_helpdesk_articles(p_website_id text, p_locale text, p_articles jsonb)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare v_count int;
begin
  insert into helpdesk_articles (website_id, locale, article_id, title, url, category, content_md, content_hash, source_updated_at, updated_at)
  select p_website_id, p_locale, x->>'article_id', coalesce(x->>'title', ''), coalesce(x->>'url', ''), x->>'category',
         coalesce(x->>'content', ''), md5(coalesce(x->>'title', '') || E'\n' || coalesce(x->>'content', '')),
         to_timestamp((x->>'updated_at')::double precision / 1000), now()
  from jsonb_array_elements(coalesce(p_articles, '[]'::jsonb)) x
  where coalesce(x->>'article_id', '') <> ''
  on conflict (website_id, locale, article_id) do update set
    title = excluded.title, url = excluded.url, category = excluded.category, content_md = excluded.content_md,
    content_hash = excluded.content_hash, source_updated_at = excluded.source_updated_at, updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create function public.replace_helpdesk_chunks(p_article_pk bigint, p_hash text, p_chunks jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from helpdesk_chunks where article_pk = p_article_pk;
  insert into helpdesk_chunks (article_pk, chunk_idx, text, embedding)
  select p_article_pk, (ord - 1)::int, c->>'text', (c->>'embedding')::vector
  from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) with ordinality as x(c, ord);
  update helpdesk_articles set embedded_hash = p_hash where id = p_article_pk;
end $$;

create function public.match_helpdesk(p_website_id text, p_embedding extensions.vector(768), p_k int)
returns table (title text, url text, text text, similarity float)
language sql stable security definer set search_path = public, extensions as $$
  select a.title, a.url, c.text, 1 - (c.embedding <=> p_embedding)
  from helpdesk_chunks c join helpdesk_articles a on a.id = c.article_pk
  where a.website_id = p_website_id
  order by c.embedding <=> p_embedding
  limit p_k
$$;

create function public.match_cases(p_website_id text, p_embedding extensions.vector(768), p_k int)
returns table (summary text, resolution text, final_reply text, similarity float)
language sql stable security definer set search_path = public, extensions as $$
  select c.summary, c.resolution, c.final_reply, 1 - (c.embedding <=> p_embedding)
  from cases c
  where c.website_id = p_website_id and c.resolved_at > now() - interval '90 days'
  order by c.embedding <=> p_embedding
  limit p_k
$$;

revoke execute on function public.log_ai_usage(text, text, boolean) from public, anon, authenticated;
revoke execute on function public.helpdesk_stale_articles(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.upsert_helpdesk_articles(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.replace_helpdesk_chunks(bigint, text, jsonb) from public, anon, authenticated;
revoke execute on function public.match_helpdesk(text, extensions.vector, int) from public, anon, authenticated;
revoke execute on function public.match_cases(text, extensions.vector, int) from public, anon, authenticated;
