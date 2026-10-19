-- Widget của plugin nhận `token` của website qua URL iframe (Crisp gắn vào). Lưu sha256 để Edge Function
-- xác minh request đến từ Crisp app của đúng workspace, thay cho token cá nhân của CS.
alter table public.workspaces add column crisp_widget_token_hash text unique;
