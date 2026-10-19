-- word_edit_ratio chỉ dùng nội bộ (trigger security definer). Không cho anon/authenticated gọi qua REST,
-- và cắt chuỗi trước khi tách từ để input lớn không tốn CPU.
create or replace function public.word_edit_ratio(a text, b text)
returns numeric language plpgsql immutable set search_path = public as $$
declare
  x text[] := (regexp_split_to_array(lower(btrim(left(coalesce(a, ''), 20000))), '\s+'))[1:400];
  y text[] := (regexp_split_to_array(lower(btrim(left(coalesce(b, ''), 20000))), '\s+'))[1:400];
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
    cur := array_fill(0, array[m + 1], array[1]);
    cur[1] := i;
    for j in 1..m loop
      cur[j + 1] := least(prev[j + 1] + 1, cur[j] + 1, prev[j] + case when x[i] = y[j] then 0 else 1 end);
    end loop;
    prev := cur;
  end loop;
  return round(prev[m + 1]::numeric / greatest(n, m), 4);
end $$;
revoke execute on function public.word_edit_ratio(text, text) from public, anon, authenticated;
