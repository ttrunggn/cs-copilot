-- Membership theo danh sách operator của Crisp (review fix):
-- operators:list kích hoạt CS có trong danh sách, vô hiệu hoá CS đã bị xoá; danh sách rỗng thì bỏ qua.
-- CS chỉ xuất hiện qua tin nhắn được tạo ở trạng thái chưa kích hoạt.
create or replace function public.ingest_event(p_event jsonb)
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

    -- Danh sách rỗng thường là lỗi API: không vô hiệu hoá cả team.
    if jsonb_array_length(coalesce(d->'operators', '[]'::jsonb)) = 0 then return; end if;

    insert into operator_workspaces (crisp_user_id, website_id, active)
    select coalesce(e->'details', e)->>'user_id', v_ws, true
    from jsonb_array_elements(d->'operators') x(e)
    where coalesce(e->'details', e)->>'user_id' is not null
    on conflict (crisp_user_id, website_id) do update set active = true;

    -- CS không còn trong website Crisp thì mất quyền dùng copilot ở workspace này.
    update operator_workspaces set active = false
    where website_id = v_ws
      and crisp_user_id not in (
        select coalesce(e->'details', e)->>'user_id'
        from jsonb_array_elements(d->'operators') x(e)
        where coalesce(e->'details', e)->>'user_id' is not null);
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
      -- Chưa kích hoạt cho tới khi operators:list xác nhận CS thuộc website.
      insert into operator_workspaces (crisp_user_id, website_id, active) values (v_uid, v_ws, false) on conflict do nothing;
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

revoke execute on function public.ingest_event(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_event(jsonb) to service_role;
