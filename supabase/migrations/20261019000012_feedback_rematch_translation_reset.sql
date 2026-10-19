-- 1) Ghép draft: nếu trong 15 phút CS gửi nhiều tin, giữ tin giống draft nhất (vd "Let me check" gửi trước rồi mới gửi draft).
create or replace function public.match_draft_to_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_ratio numeric; v_old numeric; v_matched timestamptz;
begin
  select id, word_edit_ratio(content, new.content), edit_ratio, matched_at into v_id, v_ratio, v_old, v_matched
  from outputs
  where website_id = new.website_id and session_id = new.session_id and operator_id = new.operator_id
    and kind = 'draft' and created_at between new.created_at - interval '15 minutes' and new.created_at
  order by created_at desc limit 1;
  if v_id is null or (v_matched is not null and v_ratio >= v_old) then return null; end if;
  update outputs set
    final_text = new.content, final_fingerprint = new.fingerprint, matched_at = new.created_at, edit_ratio = v_ratio,
    outcome = case when v_ratio < 0.05 then 'sent_as_is' when v_ratio < 0.4 then 'light_edit' else 'heavy_edit' end
  where id = v_id;
  return null;
end $$;

-- 2) Tin bị sửa nội dung (ingest ghi đè) thì bản dịch cũ không còn đúng: xoá để lần sau dịch lại.
create function public.reset_stale_translation()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.content is distinct from old.content and new.content_en is not distinct from old.content_en then
    new.content_en := null;
  end if;
  return new;
end $$;
create trigger messages_reset_translation before update of content on public.messages
for each row execute function public.reset_stale_translation();
revoke execute on function public.reset_stale_translation() from public, anon, authenticated;
