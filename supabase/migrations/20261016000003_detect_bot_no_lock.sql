-- detect_bot không còn SELECT ... FOR UPDATE dòng workspace: khoá đó xung đột với KEY SHARE của FK
-- (insert conversations) và gây deadlock khi nhiều batch ingest chạy song song.
-- Chỉ khi học user_id bot mới thì UPDATE có điều kiện (NO KEY UPDATE, không xung đột KEY SHARE).
create or replace function public.detect_bot(p_website_id text, p_user_id text, p_nickname text)
returns boolean language plpgsql as $$
declare
  v_ids jsonb;
  v_nick text := lower(coalesce(p_nickname, ''));
  v_learned text;
begin
  select bot_identifiers into v_ids from public.workspaces where website_id = p_website_id;
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
    if p_user_id is null then return true; end if;
    update public.workspaces
    set bot_identifiers = jsonb_set(bot_identifiers, '{learned}',
                                    coalesce(bot_identifiers->'learned', '{}'::jsonb) || jsonb_build_object(v_nick, p_user_id))
    where website_id = p_website_id
      and not (coalesce(bot_identifiers->'learned', '{}'::jsonb) ? v_nick);
    if found then return true; end if;
    -- transaction khác vừa học nickname này: đọc lại giá trị đã commit
    select bot_identifiers->'learned'->>v_nick into v_learned from public.workspaces where website_id = p_website_id;
  end if;

  return coalesce(v_learned = p_user_id, false); -- trùng nickname bot nhưng khác user_id đã học: người thật
end $$;

revoke execute on function public.detect_bot(text, text, text) from public, anon, authenticated;
