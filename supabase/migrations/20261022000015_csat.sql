-- Trạng thái đã gửi CSAT survey cho từng conversation, để panel không gửi trùng
-- và hiện được "đã gửi lúc nào, bởi ai". Việc gửi thật vẫn qua webhook
-- send-survey của workflow survey trên n8n (n8n làm gate, giữ plugin key).

create table public.csat_survey_sends (
  website_id text not null references public.workspaces on delete cascade,
  session_id text not null,
  sent_by text not null,
  sent_at timestamptz not null default now(),
  primary key (website_id, session_id)
);

alter table public.csat_survey_sends enable row level security;
