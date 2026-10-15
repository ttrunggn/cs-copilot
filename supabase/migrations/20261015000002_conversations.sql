create table public.conversations (
  website_id text not null references public.workspaces on delete cascade,
  session_id text not null,
  customer_email text,
  customer_name text,
  segments text[] not null default '{}',
  topic text,
  topic_source text check (topic_source in ('segment', 'ai')),
  state text,
  assigned_operator text,
  last_customer_at timestamptz,
  last_human_operator_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (website_id, session_id)
);

create table public.messages (
  id bigint generated always as identity primary key,
  website_id text not null,
  session_id text not null,
  fingerprint text not null,
  "from" text not null check ("from" in ('user', 'operator')),
  type text not null,
  operator_id text,
  operator_name text,
  is_bot boolean not null default false,
  content text not null default '',
  created_at timestamptz not null,
  unique (website_id, session_id, fingerprint),
  foreign key (website_id, session_id) references public.conversations on delete cascade
);
create index messages_session_time on public.messages (website_id, session_id, created_at);
create index messages_operator_time on public.messages (operator_id, created_at) where not is_bot;

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create function public.render_crisp_content(p_type text, p_content jsonb)
returns text language sql immutable as $$
  select case
    when p_content is null or p_content = 'null'::jsonb then ''
    when jsonb_typeof(p_content) = 'string' then p_content #>> '{}'
    when p_type = 'file' then '[file] ' || coalesce(p_content->>'name', '') || ' ' || coalesce(p_content->>'url', '')
    else p_content::text
  end
$$;

create function public.resolve_topic_from_segments(p_topics jsonb, p_segments text[])
returns text language sql immutable as $$
  select t->>'key'
  from jsonb_array_elements(coalesce(p_topics, '[]'::jsonb)) with ordinality as x(t, ord)
  where exists (
    select 1 from jsonb_array_elements_text(coalesce(t->'segments', '[]'::jsonb)) s
    where lower(s) in (select lower(unnest(p_segments)))
  )
  order by ord
  limit 1
$$;

-- Trả true nếu tin operator là của bot. Lần đầu gặp nickname bot thì ghi user_id vào learned.
create function public.detect_bot(p_website_id text, p_user_id text, p_nickname text)
returns boolean language plpgsql as $$
declare
  v_ids jsonb;
  v_nick text := lower(coalesce(p_nickname, ''));
  v_learned text;
begin
  select bot_identifiers into v_ids from public.workspaces where website_id = p_website_id for update;
  if v_ids is null then return false; end if;

  if p_user_id is not null and exists (
       select 1 from jsonb_each_text(coalesce(v_ids->'learned', '{}'::jsonb)) e where e.value = p_user_id) then
    return true;
  end if;

  if v_nick = '' or not exists (
       select 1 from jsonb_array_elements_text(coalesce(v_ids->'nicknames', '[]'::jsonb)) n where lower(n) = v_nick) then
    return false;
  end if;

  v_learned := v_ids->'learned'->>v_nick;
  if v_learned is null then
    if p_user_id is not null then
      update public.workspaces
      set bot_identifiers = jsonb_set(bot_identifiers, '{learned}',
                                      coalesce(bot_identifiers->'learned', '{}'::jsonb) || jsonb_build_object(v_nick, p_user_id))
      where website_id = p_website_id;
    end if;
    return true;
  end if;

  return false; -- trùng nickname bot nhưng khác user_id đã học: người thật
end $$;

create function public.ingest_event(p_event jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(p_event->'data', '{}'::jsonb);
  v_ws text := coalesce(p_event->>'website_id', d->>'website_id');
  v_ev text := p_event->>'event';
  v_sid text := d->>'session_id';
  v_from text; v_type text; v_uid text; v_nick text; v_content text;
  v_ts timestamptz; v_bot boolean; v_topic text;
begin
  if not exists (select 1 from workspaces where website_id = v_ws) then
    raise exception 'unknown website_id %', v_ws;
  end if;

  if v_ev = 'operators:list' then
    insert into operators (crisp_user_id, email, display_name, updated_at)
    select o->>'user_id', o->>'email',
           nullif(trim(coalesce(o->>'first_name', '') || ' ' || coalesce(o->>'last_name', '')), ''), now()
    from jsonb_array_elements(coalesce(d->'operators', '[]'::jsonb)) x(e)
    cross join lateral (select coalesce(e->'details', e) as o) y
    where o->>'user_id' is not null
    on conflict (crisp_user_id) do update
      set email = coalesce(excluded.email, operators.email),
          display_name = coalesce(excluded.display_name, operators.display_name),
          updated_at = now();

    insert into operator_workspaces (crisp_user_id, website_id)
    select coalesce(e->'details', e)->>'user_id', v_ws
    from jsonb_array_elements(coalesce(d->'operators', '[]'::jsonb)) x(e)
    where coalesce(e->'details', e)->>'user_id' is not null
    on conflict do nothing;
    return;
  end if;

  if v_sid is null then raise exception 'missing session_id'; end if;
  insert into conversations (website_id, session_id) values (v_ws, v_sid) on conflict do nothing;

  if v_ev in ('message:send', 'message:received', 'message:import') then
    v_from := d->>'from';
    if v_from is null or v_from not in ('user', 'operator') then return; end if;
    v_type := coalesce(d->>'type', 'text');
    v_ts := coalesce(to_timestamp((d->>'timestamp')::bigint / 1000.0), now());
    v_uid := d->'user'->>'user_id';
    v_nick := d->'user'->>'nickname';
    v_content := render_crisp_content(v_type, d->'content');
    v_bot := v_from = 'operator'
             and (detect_bot(v_ws, v_uid, v_nick) or (v_type = 'note' and starts_with(v_content, '🤖')));

    insert into messages (website_id, session_id, fingerprint, "from", type, operator_id, operator_name, is_bot, content, created_at)
    values (v_ws, v_sid, coalesce(d->>'fingerprint', md5(d::text)), v_from, v_type,
            case when v_from = 'operator' then v_uid end,
            case when v_from = 'operator' then v_nick end,
            v_bot, v_content, v_ts)
    on conflict (website_id, session_id, fingerprint)
      do update set content = excluded.content, is_bot = excluded.is_bot;

    if v_from = 'operator' and not v_bot and v_uid is not null then
      insert into operators (crisp_user_id, display_name) values (v_uid, v_nick)
      on conflict (crisp_user_id) do update set display_name = coalesce(operators.display_name, excluded.display_name);
      insert into operator_workspaces (crisp_user_id, website_id) values (v_uid, v_ws) on conflict do nothing;
    end if;

    update conversations c set
      last_customer_at = greatest(c.last_customer_at,
                                  case when v_from = 'user' then v_ts end),
      assigned_operator = case
                            when v_from = 'operator' and not v_bot and v_type not in ('note', 'event')
                                 and v_uid is not null
                                 and v_ts >= coalesce(c.last_human_operator_at, '-infinity'::timestamptz)
                            then v_uid else c.assigned_operator end,
      last_human_operator_at = greatest(c.last_human_operator_at,
                                        case when v_from = 'operator' and not v_bot and v_type not in ('note', 'event') then v_ts end),
      updated_at = now()
    where website_id = v_ws and session_id = v_sid;

  elsif v_ev in ('session:set_segments', 'session:set_state', 'session:set_email', 'session:meta') then
    update conversations c set
      segments = case when d ? 'segments' then array(select jsonb_array_elements_text(coalesce(d->'segments', '[]'::jsonb)))
                      else c.segments end,
      state = coalesce(d->>'state', c.state),
      resolved_at = case when d->>'state' = 'resolved' then coalesce(c.resolved_at, now())
                         when d->>'state' in ('pending', 'unresolved') then null
                         else c.resolved_at end,
      customer_email = coalesce(nullif(d->>'email', ''), c.customer_email),
      customer_name = coalesce(nullif(d->>'nickname', ''), c.customer_name),
      updated_at = now()
    where website_id = v_ws and session_id = v_sid;

    if d ? 'segments' then
      v_topic := resolve_topic_from_segments(
        (select topics from workspaces where website_id = v_ws),
        array(select jsonb_array_elements_text(coalesce(d->'segments', '[]'::jsonb))));
      update conversations set
        topic = case when v_topic is not null then v_topic
                     when topic_source = 'segment' then null else topic end,
        topic_source = case when v_topic is not null then 'segment'
                            when topic_source = 'segment' then null else topic_source end
      where website_id = v_ws and session_id = v_sid;
    end if;
  end if;
end $$;

create function public.ingest_events(p_events jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare e jsonb; n int := 0;
begin
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    perform ingest_event(e);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.ingest_event(jsonb) from public, anon, authenticated;
revoke execute on function public.ingest_events(jsonb) from public, anon, authenticated;
revoke execute on function public.detect_bot(text, text, text) from public, anon, authenticated;
grant execute on function public.ingest_event(jsonb) to service_role;
grant execute on function public.ingest_events(jsonb) to service_role;
