-- Panel hiện badge đổi trạng thái dạng "từ <cũ> → <mới>": cần biết trạng thái
-- TRƯỚC lần đổi gần nhất. Trước đây saveIssue chỉ ghi đè status + mốc
-- status_changed_at nên giá trị cũ mất hẳn. prev_status được jira-sync ghi
-- đúng lúc phát hiện đổi trạng thái (cùng thời điểm với status_changed_at):
-- prev_status = status bị thay thế; không đổi trạng thái thì giữ nguyên.
alter table public.jira_issues add column prev_status text;
