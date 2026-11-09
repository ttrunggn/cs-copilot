-- Jira = PANEL-ONLY MIRROR tuyệt đối : Jira thay đổi gì thì chỉ
-- panel thay đổi theo (status, content, comment mới) — sync KHÔNG tạo bất cứ thứ gì trong Crisp.
-- Code jira-sync không có đường đăng note và không đọc cờ jira_auto_note; hai lệnh
-- dưới đây là lớp phòng thủ phụ: tắt cờ cho mọi workspace hiện hữu và đổi mặc định cho
-- workspace mới, để dữ liệu trong DB cũng phản ánh đúng quy tắc.
update public.workspaces set jira_auto_note = false;
alter table public.workspaces alter column jira_auto_note set default false;
