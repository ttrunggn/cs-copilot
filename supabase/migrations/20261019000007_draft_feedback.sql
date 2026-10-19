-- Khoảng cách Levenshtein theo từ (không phân biệt hoa thường) chia cho độ dài lớn hơn. 0 = giống hệt, 1 = khác hoàn toàn.
create function public.word_edit_ratio(a text, b text)
returns numeric language plpgsql immutable set search_path = public as $$
declare
  x text[] := (regexp_split_to_array(lower(btrim(coalesce(a, ''))), '\s+'))[1:400];
  y text[] := (regexp_split_to_array(lower(btrim(coalesce(b, ''))), '\s+'))[1:400];
  n int; m int; prev int[]; cur int[]; i int; j int;
begin
  if x = array[''] then x := '{}'; end if;
  if y = array[''] then y := '{}'; end if;
  n := coalesce(array_length(x, 1), 0);
  m := coalesce(array_length(y, 1), 0);
  if n = 0 and m = 0 then return 0; end if;
  if n = 0 or m = 0 then return 1; end if;
  prev := array(select generate_series(0, m));
  for i in 1..n loop
    cur := array[i];
    for j in 1..m loop
      cur := cur || least(prev[j + 1] + 1, cur[j] + 1, prev[j] + case when x[i] = y[j] then 0 else 1 end);
    end loop;
    prev := cur;
  end loop;
  return round(prev[m + 1]::numeric / greatest(n, m), 4);
end $$;

-- Ghép tin CS vừa gửi với draft gần nhất của chính CS đó trong cùng session (≤ 15 phút trước).
create function public.match_draft_to_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_ratio numeric;
begin
  select id into v_id from outputs
  where website_id = new.website_id and session_id = new.session_id and operator_id = new.operator_id
    and kind = 'draft' and matched_at is null
    and created_at between new.created_at - interval '15 minutes' and new.created_at
  order by created_at desc limit 1;
  if v_id is null then return null; end if;
  select word_edit_ratio(content, new.content) into v_ratio from outputs where id = v_id;
  update outputs set
    final_text = new.content, final_fingerprint = new.fingerprint, matched_at = new.created_at, edit_ratio = v_ratio,
    outcome = case when v_ratio < 0.05 then 'sent_as_is' when v_ratio < 0.4 then 'light_edit' else 'heavy_edit' end
  where id = v_id;
  return null;
end $$;

create trigger messages_match_draft
after insert on public.messages
for each row when (new."from" = 'operator' and new.type = 'text' and not new.is_bot and new.operator_id is not null)
execute function public.match_draft_to_message();

-- Draft quá 15 phút chưa ghép được tính là 'ignored'; draft còn trong cửa sổ chưa tính.
create view public.draft_feedback_stats with (security_invoker = true) as
with d as (
  select website_id, prompt_version, topic, operator_id, edit_ratio,
         coalesce(outcome, case when matched_at is null and created_at < now() - interval '15 minutes' then 'ignored' end) as eff
  from public.outputs where kind = 'draft'
)
select website_id, prompt_version, topic, operator_id,
       count(*) as drafts,
       round(100.0 * count(*) filter (where eff = 'sent_as_is') / count(*), 1) as sent_as_is_pct,
       round(100.0 * count(*) filter (where eff = 'light_edit') / count(*), 1) as light_edit_pct,
       round(100.0 * count(*) filter (where eff = 'heavy_edit') / count(*), 1) as heavy_edit_pct,
       round(100.0 * count(*) filter (where eff = 'ignored') / count(*), 1) as ignored_pct,
       round(avg(edit_ratio), 3) as avg_edit_ratio
from d where eff is not null
group by website_id, prompt_version, topic, operator_id;

revoke execute on function public.match_draft_to_message() from public, anon, authenticated;
revoke all on public.draft_feedback_stats from anon, authenticated;
