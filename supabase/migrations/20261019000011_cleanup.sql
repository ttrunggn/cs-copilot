-- Giữ dữ liệu 90 ngày (spec 5.4 cleanup): xoá messages, outputs, cases cũ hơn. Chạy hằng đêm bằng pg_cron.
create extension if not exists pg_cron;

create function public.cleanup_old_data(p_days int default 90)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cut timestamptz := now() - make_interval(days => p_days); v_m int; v_o int; v_c int;
begin
  delete from messages where created_at < v_cut; get diagnostics v_m = row_count;
  delete from outputs where created_at < v_cut; get diagnostics v_o = row_count;
  delete from cases where resolved_at < v_cut; get diagnostics v_c = row_count;
  return jsonb_build_object('messages', v_m, 'outputs', v_o, 'cases', v_c);
end $$;
revoke execute on function public.cleanup_old_data(int) from public, anon, authenticated;

select cron.schedule('copilot-cleanup', '30 20 * * *', $$select public.cleanup_old_data(90)$$); -- 03:30 giờ VN
