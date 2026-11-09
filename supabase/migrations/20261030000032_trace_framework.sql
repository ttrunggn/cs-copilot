-- 032: Khung truy vết toàn diện cho panel gộp (mọi lượt vận hành đều
-- truy lại được, kể cả các lần đo sentiment).
--
-- 1) trace_log thêm flow_id: mỗi lượt vận hành (một request, một hook, một
--    lượt mở modal) có một mã luồng duy nhất; mọi dòng timing/error của các
--    stage thuộc lượt đó mang cùng flow_id để truy lại toàn bộ đường đi.
--    Cột nullable nên các dòng cũ và các caller chưa truyền flow_id vẫn hợp lệ.
--
-- 2) sentiment_history (append-only): conversation_sentiment chỉ giữ bản đo
--    mới nhất (saveSentiment upsert ghi đè) nên không truy lại được các lần
--    đo trước. Từ nay mỗi lần tính MỚI sentiment ghi thêm đúng 1 dòng ở đây:
--    dấu vân tay đầu vào, kết quả đo, model, và nguồn kích hoạt
--    (analyze | precompute | generate). Bảng này vừa là vết đo xuyên thời
--    gian, vừa là dữ kiện trend cho panel gộp (thay engine đo theo tin của
--    chatbot). Cache hit không ghi (không phải lần đo mới).

alter table public.trace_log
  add column if not exists flow_id text;

create index if not exists trace_log_flow_idx
  on public.trace_log (flow_id);

create index if not exists trace_log_action_created_idx
  on public.trace_log (action, created_at desc);

create table if not exists public.sentiment_history (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  website_id text not null references public.workspaces on delete cascade,
  session_id text not null,
  input_fp text not null,
  score int not null check (score between 0 and 100),
  mood text not null check (mood in ('frustrated','confused','neutral','satisfied','happy')),
  urgency text not null check (urgency in ('low','medium','high')),
  confidence numeric not null default 0.5,
  summary text not null default '',
  signals jsonb not null default '[]'::jsonb,
  issues jsonb not null default '[]'::jsonb,
  model text,
  source text not null default 'unknown'
);

create index if not exists sentiment_history_session_idx
  on public.sentiment_history (website_id, session_id, created_at desc);

alter table public.sentiment_history enable row level security;

grant select, insert on public.sentiment_history to service_role;
