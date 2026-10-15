# CS Copilot v5 — Plan 1: Nền tảng (schema, ingest, `check`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dữ liệu Crisp của cả 2 workspace chảy vào Supabase (đã gắn cờ bot, có topic từ segment). Edge Function `copilot` trả lời `action=check` (tin chưa trả lời, topic, profile đang dùng) cho đúng CS của đúng workspace.

**Architecture:** n8n chỉ chuyển payload Crisp thô vào RPC Postgres `ingest_event`. Mọi chuẩn hoá (chống trùng, `is_bot`, mốc thời gian, segment → topic) nằm trong SQL. Edge Function `copilot` (Deno/TypeScript) đọc DB qua interface `Db` và gọi n8n qua interface `N8n`, nên handler test được bằng fake.

**Tech Stack:** Supabase (Postgres 15 + pgTAP, Edge Functions/Deno 2), Supabase CLI qua `npx`, Docker (stack local), n8n (HTTP Request v4.2, Code v2, Webhook v2), Crisp REST API v1 (plugin token, header `X-Crisp-Tier: plugin`).

**Spec:** `docs/superpowers/specs/2026-10-15-cs-copilot-multi-workspace-design.md`

## Lộ trình các plan

| Plan | Nội dung | Phụ thuộc |
|---|---|---|
| **1 (file này)** | Schema cấu hình + hội thoại, RPC ingest, n8n ingest/refresh/post-note/sync, shared TS, `copilot` action `check` | — |
| 2 | Gemini module + fallback, helpdesk sync/embed, `cases`, action `generate` (draft + verify) và `handoff` | 1 |
| 3 | Jira: `jira_links`/`jira_issues`/`jira_comments`, link-indexer, jira-sync, `jira-diff` auto-note, Jira trong `check`/`generate` | 1 |
| 4 | Job nền: `classify-topics`, `index-cases`, `learn-profiles`, `cleanup` (pg_cron) | 1, 2 |
| 5 | Chrome extension (thanh công cụ trên ô Reply, điền draft) + tắt v4 | 1–3 |

Vòng phản hồi draft → tin gửi (`outputs.final_text`, `edit_ratio`, `prompt_variants`) nằm ở Plan 2.

## Global Constraints

- Mọi bảng nghiệp vụ có cột `website_id`.
- Credential Crisp/Jira chỉ nằm trong n8n. Supabase không gọi trực tiếp Crisp/Jira mà gọi webhook n8n với header `x-copilot-secret`.
- Tin của bot (`bot_identifiers.nicknames` = `["Mary","Zoey"]`, map `learned` nickname → user_id) và note bắt đầu bằng `🤖` có `is_bot = true` và bị loại ở mọi nơi.
- Copilot không bao giờ gửi tin cho khách, chỉ tạo private note.
- Thời gian Crisp là epoch **mili-giây**, lưu thành `timestamptz`.
- RLS bật trên mọi bảng, không có policy. Chỉ `service_role` truy cập. RPC chỉ grant execute cho `service_role`.
- Import pin version: `jsr:@std/assert@1`, `npm:@supabase/supabase-js@2`.
- Text hiển thị cho CS viết bằng tiếng Việt.
- Xác thực: token riêng cho từng CS, gửi qua header `x-copilot-token`. DB chỉ lưu sha256 hex (`operators.copilot_token_hash`). Không có secret dùng chung theo workspace.
- Giao diện cuối cùng là Chrome extension (Plan 5). Plan 1 kiểm tra bằng curl.
- Dùng **project Supabase mới** cho v5 (project v4 đã có bảng `agent_profiles` khác schema).

## Review Focus

1. **Tin operator không có `user` object** (gửi từ app mobile/API) → vẫn lưu, `operator_id` null, không crash. Test: Task 3, assert 16–17.
2. **Tin đến không theo thứ tự** (refresh/backfill import tin cũ sau webhook tin mới) → `last_human_operator_at` và `assigned_operator` không bị lùi. Test: Task 3, assert 14–15.
3. **Nội dung không phải chuỗi** (file, object) → lưu dạng text đọc được. Test: Task 3, assert 18.
4. **n8n refresh treo** → `check` vẫn trả về trong ~3s với `stale: true`. Test: Task 6, `refresh hang`.
5. **Conversation chỉ có khách + bot, chưa có CS người** → toàn bộ tin khách tính là chưa trả lời. Test: Task 4, `bot replies do not count`.

---

## File Structure

```
package.json                         # devDependency supabase CLI + scripts
deno.json                            # task test cho Deno
.gitignore
legacy/                              # 4 workflow v4 (chỉ di chuyển)
supabase/
  config.toml                        # project_id = "cs-copilot", [functions.copilot] verify_jwt=false
  migrations/
    20261015000001_config.sql        # workspaces, operators, operator_workspaces, ai_config, ai_usage_log, agent_profiles
    20261015000002_conversations.sql # conversations, messages, helper fns, ingest_event(s)
  tests/
    config_test.sql                  # pgTAP
    ingest_test.sql                  # pgTAP
  seed/workspaces.example.sql        # mẫu insert 2 workspace
  functions/
    .env.example
    _shared/
      types.ts                       # kiểu dữ liệu dùng chung
      context.ts                     # transcript + tin chưa trả lời
      profile.ts                     # chọn profile + override
      auth.ts                        # HttpError + authorize()
      n8n.ts                         # refreshConversation / postNote
      db.ts                          # interface Db + adapter supabase-js
    copilot/
      handler.ts                     # handle(body, deps) thuần
      index.ts                       # Deno.serve wrapper
    tests/
      context.test.ts
      profile.test.ts
      auth.test.ts
      n8n.test.ts
      handler.test.ts
n8n/
  ingest-crisp.json
  copilot-refresh.json
  copilot-post-note.json
  crisp-sync.json
  validate.test.ts                   # kiểm tra cấu trúc JSON workflow
```

---

### Task 1: Scaffold repo và công cụ

**Files:**
- Create: `package.json`, `deno.json`, `.gitignore`, `supabase/config.toml` (sinh bởi CLI rồi sửa), `supabase/functions/.env.example`
- Move: `crisp-*.n8n.json` → `legacy/`

**Interfaces:**
- Produces: lệnh `npm run db:test` (pgTAP) và `deno task test` (Deno tests) cho mọi task sau.

- [ ] **Step 1: Cài Deno**

Run (PowerShell): `winget install --id DenoLand.Deno -e`
Fallback: `npm install -g deno`
Kiểm tra: `deno --version` → `deno 2.x`

- [ ] **Step 2: Tạo `package.json`**

```json
{
  "name": "cs-copilot",
  "private": true,
  "scripts": {
    "sb": "supabase",
    "db:start": "supabase start",
    "db:reset": "supabase db reset",
    "db:test": "supabase test db"
  },
  "devDependencies": {
    "supabase": "^2"
  }
}
```

Run: `npm install`
Expected: `node_modules/.bin/supabase` tồn tại. `npx supabase --version` in ra `2.x`.

- [ ] **Step 3: Khởi tạo Supabase**

Run (Git Bash): `echo n | npx supabase init`
Expected: tạo `supabase/config.toml`.

Sửa `supabase/config.toml`: đổi dòng `project_id` thành:

```toml
project_id = "cs-copilot"
```

Thêm vào cuối file:

```toml
[functions.copilot]
verify_jwt = false
```

- [ ] **Step 4: Tạo `deno.json`, `.gitignore`, `.env.example`**

`deno.json`:

```json
{
  "tasks": {
    "test": "deno test supabase/functions/tests"
  }
}
```

(Task 8 sẽ thêm `n8n` và `--allow-read` vào lệnh này.)

`.gitignore`:

```
node_modules/
supabase/.branches/
supabase/.temp/
supabase/functions/.env
.env
```

`supabase/functions/.env.example`:

```
N8N_WEBHOOK_BASE=https://YOUR-N8N-DOMAIN/webhook
N8N_SHARED_SECRET=replace-with-openssl-rand-hex-24
```

Run: `cp supabase/functions/.env.example supabase/functions/.env`

- [ ] **Step 5: Di chuyển workflow v4 sang `legacy/`**

Run: `mkdir -p legacy && git mv -k crisp-*.n8n.json legacy/ 2>/dev/null || mv crisp-*.n8n.json legacy/`

- [ ] **Step 6: Khởi động stack local**

Run: `npm run db:start` (Docker Desktop phải đang chạy)
Expected: in ra `API URL: http://127.0.0.1:54321` và `service_role key`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json deno.json .gitignore supabase/config.toml supabase/functions/.env.example legacy/
git commit -m "chore: scaffold supabase + deno, move v4 workflows to legacy"
```

---

### Task 2: Migration cấu hình + profile

**Files:**
- Create: `supabase/migrations/20261015000001_config.sql`
- Test: `supabase/tests/config_test.sql`

**Interfaces:**
- Produces: các bảng `workspaces`, `operators`, `operator_workspaces`, `ai_config`, `ai_usage_log`, `agent_profiles` với cột đúng như dưới. TS (Task 4–7) đọc `workspaces(website_id,name,topics,default_profile)`, `operator_workspaces(crisp_user_id,website_id,active)`, `operators(crisp_user_id,display_name,copilot_token_hash)`, `agent_profiles(*)`.
- Produces: RPC `public.issue_copilot_token(p_crisp_user_id text) returns text`, trả token plaintext (48 ký tự hex) và lưu `copilot_token_hash = encode(sha256(token), 'hex')`.

- [ ] **Step 1: Viết test pgTAP (fail)**

`supabase/tests/config_test.sql`:

```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

select has_table('public', 'workspaces', 'workspaces exists');
select has_table('public', 'operators', 'operators exists');
select has_table('public', 'operator_workspaces', 'operator_workspaces exists');
select has_table('public', 'ai_config', 'ai_config exists');
select has_table('public', 'ai_usage_log', 'ai_usage_log exists');
select has_table('public', 'agent_profiles', 'agent_profiles exists');

select is((select count(*)::int from public.ai_config), 7, 'ai_config seeded with 7 tasks');
select is((select models[1] from public.ai_config where task = 'draft'), 'gemini-3.5-flash-lite', 'draft uses flash-lite first');

insert into public.workspaces (website_id, name) values ('ws-t', 'T');
select is((select bot_identifiers from public.workspaces where website_id = 'ws-t'),
          '{"nicknames": ["Mary", "Zoey"], "learned": {}}'::jsonb, 'bot defaults to Mary/Zoey');

insert into public.operators (crisp_user_id, display_name) values ('op-t', 'T');
create temp table issued as select public.issue_copilot_token('op-t') as token;
select is((select length(token) from issued), 48, 'token is 48 hex chars');
select is((select copilot_token_hash from public.operators where crisp_user_id = 'op-t'),
          (select encode(extensions.digest(token, 'sha256'), 'hex') from issued), 'stores sha256 of token');

select is((select bool_and(relrowsecurity) from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('workspaces','operators','operator_workspaces','ai_config','ai_usage_log','agent_profiles')),
          true, 'RLS enabled on all config tables');

select * from finish();
rollback;
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npm run db:test`
Expected: FAIL `config_test.sql` (bảng chưa tồn tại).

- [ ] **Step 3: Viết migration**

`supabase/migrations/20261015000001_config.sql`:

```sql
create table public.workspaces (
  website_id text primary key,
  name text not null,
  jira_project text,
  helpdesk_locale text not null default 'en',
  topics jsonb not null default '[]'::jsonb,
  bot_identifiers jsonb not null default '{"nicknames": ["Mary", "Zoey"], "learned": {}}'::jsonb,
  cs_jira_authors text[] not null default '{}',
  default_profile jsonb not null default '{}'::jsonb,
  min_conversations_per_topic int not null default 5,
  jira_auto_note boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.operators (
  crisp_user_id text primary key,
  email text,
  display_name text,
  jira_display_name text,
  copilot_token_hash text unique,
  updated_at timestamptz not null default now()
);

create table public.operator_workspaces (
  crisp_user_id text not null references public.operators on delete cascade,
  website_id text not null references public.workspaces on delete cascade,
  active boolean not null default true,
  primary key (crisp_user_id, website_id)
);

create table public.ai_config (
  task text primary key,
  models text[] not null
);

insert into public.ai_config (task, models) values
  ('draft',        array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('verify',       array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('handoff',      array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('classify',     array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('learn',        array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('case_summary', array['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-2.5-flash']),
  ('embed',        array['gemini-embedding-2']);

create table public.ai_usage_log (
  day date not null,
  model text not null,
  task text not null,
  calls int not null default 0,
  errors_429 int not null default 0,
  primary key (day, model, task)
);

create table public.agent_profiles (
  crisp_user_id text not null,
  website_id text not null references public.workspaces on delete cascade,
  topic text not null,                       -- '_all' = profile chung
  tone text,
  pronoun_self text,
  pronoun_customer text,
  use_emoji boolean,
  signature text,
  sample_messages text[] not null default '{}',
  style_notes text,
  conversations_used int not null default 0,
  learned_at timestamptz,
  manual_override jsonb,
  primary key (crisp_user_id, website_id, topic)
);

alter table public.workspaces enable row level security;
alter table public.operators enable row level security;
alter table public.operator_workspaces enable row level security;
alter table public.ai_config enable row level security;
alter table public.ai_usage_log enable row level security;
alter table public.agent_profiles enable row level security;

-- Cấp token mới cho CS (token cũ mất hiệu lực). Plaintext chỉ trả về một lần.
create function public.issue_copilot_token(p_crisp_user_id text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := encode(gen_random_bytes(24), 'hex');
begin
  update operators set copilot_token_hash = encode(digest(v_token, 'sha256'), 'hex'), updated_at = now()
  where crisp_user_id = p_crisp_user_id;
  if not found then raise exception 'unknown operator %', p_crisp_user_id; end if;
  return v_token;
end $$;
revoke execute on function public.issue_copilot_token(text) from public, anon, authenticated;
```

- [ ] **Step 4: Áp migration và chạy test**

Run: `npm run db:reset && npm run db:test`
Expected: `config_test.sql .. ok`, 12/12 PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261015000001_config.sql supabase/tests/config_test.sql
git commit -m "feat(db): config, operator and profile tables"
```

---

### Task 3: Migration hội thoại + RPC `ingest_event`

**Files:**
- Create: `supabase/migrations/20261015000002_conversations.sql`
- Test: `supabase/tests/ingest_test.sql`

**Interfaces:**
- Consumes: bảng của Task 2.
- Produces:
  - `public.ingest_event(p_event jsonb) returns void`, với `p_event = {website_id, event, data}`. Các `event` hỗ trợ: `message:send`, `message:received`, `message:import` (data = object message của Crisp), `session:set_segments`, `session:set_state`, `session:set_email`, `session:meta` (data = `{session_id, email?, nickname?, segments?, state?}`), `operators:list` (data = `{operators: [...]}`, phần tử dạng Crisp `{details:{user_id,email,first_name,last_name}}` hoặc phẳng).
  - `public.ingest_events(p_events jsonb) returns int`: lặp qua mảng, trả về số event.
  - Bảng `conversations`, `messages` (cột như dưới). TS đọc `messages(from,type,is_bot,content,created_at,operator_name)`.
  - PostgREST: `POST /rest/v1/rpc/ingest_event` body `{"p_event": {...}}`, `POST /rest/v1/rpc/ingest_events` body `{"p_events": [...]}`.

- [ ] **Step 1: Viết test pgTAP (fail)**

`supabase/tests/ingest_test.sql`:

```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

insert into public.workspaces (website_id, name, topics) values
  ('ws1', 'App A',
   '[{"key":"billing","label":"Billing","segments":["billing","payment"]},
     {"key":"bug","label":"Bug","segments":["bug"]}]');

create function pg_temp.msg(fp int, frm text, ts bigint, content jsonb,
                            uid text default null, nick text default null, typ text default 'text')
returns jsonb language sql as $$
  select jsonb_build_object(
    'website_id', 'ws1',
    'event', case when frm = 'user' then 'message:send' else 'message:received' end,
    'data', jsonb_strip_nulls(jsonb_build_object(
      'session_id', 's1', 'fingerprint', fp, 'from', frm, 'type', typ,
      'content', content, 'timestamp', ts,
      'user', case when uid is null and nick is null then null
                   else jsonb_strip_nulls(jsonb_build_object('user_id', uid, 'nickname', nick)) end)))
$$;

create function pg_temp.conv() returns public.conversations language sql as $$
  select * from public.conversations where website_id = 'ws1' and session_id = 's1'
$$;

-- 1-4: tin khách + chống trùng
select lives_ok($$ select public.ingest_event(pg_temp.msg(1, 'user', 1760500000000, '"hi"')) $$, 'ingests customer message');
select is((select count(*)::int from public.messages where session_id = 's1'), 1, 'stores one message');
do $$ begin perform public.ingest_event(pg_temp.msg(1, 'user', 1760500000000, '"hi"')); end $$;
select is((select count(*)::int from public.messages where session_id = 's1'), 1, 'dedupes by fingerprint');
select is((pg_temp.conv()).last_customer_at, to_timestamp(1760500000), 'sets last_customer_at');

-- 5-6: bot Mary được nhận diện và học user_id
do $$ begin perform public.ingest_event(pg_temp.msg(2, 'operator', 1760500001000, '"I am Mary"', 'bot-mary', 'mary')); end $$;
select ok((select is_bot from public.messages where fingerprint = '2'), 'Mary is a bot');
select is((select bot_identifiers->'learned'->>'mary' from public.workspaces where website_id = 'ws1'), 'bot-mary', 'learns Mary user_id');

-- 7: người thật tên Mary (khác user_id) không phải bot
do $$ begin perform public.ingest_event(pg_temp.msg(3, 'operator', 1760500003000, '"hello"', 'human-mary', 'Mary')); end $$;
select ok(not (select is_bot from public.messages where fingerprint = '3'), 'human named Mary is not a bot');

-- 8: bot đổi nickname vẫn là bot
do $$ begin perform public.ingest_event(pg_temp.msg(4, 'operator', 1760500004000, '"hi again"', 'bot-mary', 'Mary v2')); end $$;
select ok((select is_bot from public.messages where fingerprint = '4'), 'learned bot id stays a bot after rename');

-- 9-11: CS người thật
do $$ begin perform public.ingest_event(pg_temp.msg(5, 'operator', 1760500005000, '"Chào bạn"', 'op-lan', 'Lan')); end $$;
select ok(not (select is_bot from public.messages where fingerprint = '5'), 'Lan is human');
select is((pg_temp.conv()).last_human_operator_at, to_timestamp(1760500005), 'sets last_human_operator_at');
select ok(exists (select 1 from public.operator_workspaces where crisp_user_id = 'op-lan' and website_id = 'ws1'), 'registers Lan in workspace');

-- 12-13: note của copilot (🤖) là bot và không đổi mốc
do $$ begin perform public.ingest_event(pg_temp.msg(6, 'operator', 1760500006000, '"🤖 Draft: ..."', 'op-lan', 'Lan', 'note')); end $$;
select ok((select is_bot from public.messages where fingerprint = '6'), 'copilot note flagged as bot');
select is((pg_temp.conv()).last_human_operator_at, to_timestamp(1760500005), 'note does not move last_human_operator_at');

-- 14-15: tin cũ đến muộn không làm lùi mốc
do $$ begin perform public.ingest_event(pg_temp.msg(7, 'operator', 1760499999000, '"old"', 'op-minh', 'Minh')); end $$;
select is((pg_temp.conv()).last_human_operator_at, to_timestamp(1760500005), 'older message does not move timestamp back');
select is((pg_temp.conv()).assigned_operator, 'op-lan', 'older message does not change assigned_operator');

-- 16-17: tin operator không có user object
select lives_ok($$ select public.ingest_event(pg_temp.msg(8, 'operator', 1760500008000, '"from mobile"')) $$, 'operator message without user object');
select is((pg_temp.conv()).last_human_operator_at, to_timestamp(1760500008), 'anonymous operator message counts as human');

-- 18: nội dung file
do $$ begin perform public.ingest_event(pg_temp.msg(9, 'user', 1760500009000, '{"name":"a.png","url":"https://x/a.png"}', null, null, 'file')); end $$;
select is((select content from public.messages where fingerprint = '9'), '[file] a.png https://x/a.png', 'renders file content');

-- 19-22: segment -> topic
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_segments","data":{"session_id":"s1","segments":["Payment","vip"]}}'); end $$;
select is((pg_temp.conv()).topic, 'billing', 'maps segment to topic (case-insensitive)');
select is((pg_temp.conv()).topic_source, 'segment', 'topic_source = segment');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_segments","data":{"session_id":"s1","segments":["vip"]}}'); end $$;
select is((pg_temp.conv()).topic, null::text, 'clears segment topic when no segment matches');
update public.conversations set topic = 'bug', topic_source = 'ai' where session_id = 's1';
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_segments","data":{"session_id":"s1","segments":["vip"]}}'); end $$;
select is((pg_temp.conv()).topic, 'bug', 'keeps AI topic when segments do not match');

-- 23-24: state
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_state","data":{"session_id":"s1","state":"resolved"}}'); end $$;
select ok((pg_temp.conv()).resolved_at is not null, 'resolved sets resolved_at');
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"session:set_state","data":{"session_id":"s1","state":"unresolved"}}'); end $$;
select ok((pg_temp.conv()).resolved_at is null, 'reopen clears resolved_at');

-- 25: danh sách operator
do $$ begin perform public.ingest_event('{"website_id":"ws1","event":"operators:list","data":{"operators":[{"type":"operator","details":{"user_id":"op-hoa","email":"hoa@x.io","first_name":"Hoa","last_name":"Tran"}}]}}'); end $$;
select ok(exists (select 1 from public.operators o join public.operator_workspaces w using (crisp_user_id)
                  where o.crisp_user_id = 'op-hoa' and o.email = 'hoa@x.io' and w.website_id = 'ws1'), 'operators:list upserts operator + membership');

-- 26: workspace lạ
select throws_ok($$ select public.ingest_event('{"website_id":"nope","event":"message:send","data":{"session_id":"x"}}') $$,
                 'P0001', 'unknown website_id nope', 'rejects unknown workspace');

-- 27: batch
select is(public.ingest_events(jsonb_build_array(pg_temp.msg(10, 'user', 1760500010000, '"a"'), pg_temp.msg(11, 'user', 1760500011000, '"b"'))),
          2, 'ingest_events returns count');

select * from finish();
rollback;
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npm run db:test`
Expected: FAIL `ingest_test.sql` (function `ingest_event` không tồn tại).

- [ ] **Step 3: Viết migration**

`supabase/migrations/20261015000002_conversations.sql`:

```sql
create table public.conversations (
  website_id text not null references public.workspaces on delete cascade,
  session_id text not null,
  customer_email text,
  customer_name text,
  segments text[] not null default '{}',
  topic text,
  topic_source text check (topic_source in ('segment', 'ai')),
  state text,
  assigned_operator text,
  last_customer_at timestamptz,
  last_human_operator_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (website_id, session_id)
);

create table public.messages (
  id bigint generated always as identity primary key,
  website_id text not null,
  session_id text not null,
  fingerprint text not null,
  "from" text not null check ("from" in ('user', 'operator')),
  type text not null,
  operator_id text,
  operator_name text,
  is_bot boolean not null default false,
  content text not null default '',
  created_at timestamptz not null,
  unique (website_id, session_id, fingerprint),
  foreign key (website_id, session_id) references public.conversations on delete cascade
);
create index messages_session_time on public.messages (website_id, session_id, created_at);
create index messages_operator_time on public.messages (operator_id, created_at) where not is_bot;

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create function public.render_crisp_content(p_type text, p_content jsonb)
returns text language sql immutable as $$
  select case
    when p_content is null or p_content = 'null'::jsonb then ''
    when jsonb_typeof(p_content) = 'string' then p_content #>> '{}'
    when p_type = 'file' then '[file] ' || coalesce(p_content->>'name', '') || ' ' || coalesce(p_content->>'url', '')
    else p_content::text
  end
$$;

create function public.resolve_topic_from_segments(p_topics jsonb, p_segments text[])
returns text language sql immutable as $$
  select t->>'key'
  from jsonb_array_elements(coalesce(p_topics, '[]'::jsonb)) with ordinality as x(t, ord)
  where exists (
    select 1 from jsonb_array_elements_text(coalesce(t->'segments', '[]'::jsonb)) s
    where lower(s) in (select lower(unnest(p_segments)))
  )
  order by ord
  limit 1
$$;

-- Trả true nếu tin operator là của bot. Lần đầu gặp nickname bot thì ghi user_id vào learned.
create function public.detect_bot(p_website_id text, p_user_id text, p_nickname text)
returns boolean language plpgsql as $$
declare
  v_ids jsonb;
  v_nick text := lower(coalesce(p_nickname, ''));
  v_learned text;
begin
  select bot_identifiers into v_ids from public.workspaces where website_id = p_website_id for update;
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
    if p_user_id is not null then
      update public.workspaces
      set bot_identifiers = jsonb_set(bot_identifiers, '{learned}',
                                      coalesce(bot_identifiers->'learned', '{}'::jsonb) || jsonb_build_object(v_nick, p_user_id))
      where website_id = p_website_id;
    end if;
    return true;
  end if;

  return false; -- trùng nickname bot nhưng khác user_id đã học: người thật
end $$;

create function public.ingest_event(p_event jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  d jsonb := coalesce(p_event->'data', '{}'::jsonb);
  v_ws text := coalesce(p_event->>'website_id', d->>'website_id');
  v_ev text := p_event->>'event';
  v_sid text := d->>'session_id';
  v_from text; v_type text; v_uid text; v_nick text; v_content text;
  v_ts timestamptz; v_bot boolean; v_topic text;
begin
  if not exists (select 1 from workspaces where website_id = v_ws) then
    raise exception 'unknown website_id %', v_ws;
  end if;

  if v_ev = 'operators:list' then
    insert into operators (crisp_user_id, email, display_name, updated_at)
    select o->>'user_id', o->>'email',
           nullif(trim(coalesce(o->>'first_name', '') || ' ' || coalesce(o->>'last_name', '')), ''), now()
    from jsonb_array_elements(coalesce(d->'operators', '[]'::jsonb)) x(e)
    cross join lateral (select coalesce(e->'details', e) as o) y
    where o->>'user_id' is not null
    on conflict (crisp_user_id) do update
      set email = coalesce(excluded.email, operators.email),
          display_name = coalesce(excluded.display_name, operators.display_name),
          updated_at = now();

    insert into operator_workspaces (crisp_user_id, website_id)
    select coalesce(e->'details', e)->>'user_id', v_ws
    from jsonb_array_elements(coalesce(d->'operators', '[]'::jsonb)) x(e)
    where coalesce(e->'details', e)->>'user_id' is not null
    on conflict do nothing;
    return;
  end if;

  if v_sid is null then raise exception 'missing session_id'; end if;
  insert into conversations (website_id, session_id) values (v_ws, v_sid) on conflict do nothing;

  if v_ev in ('message:send', 'message:received', 'message:import') then
    v_from := d->>'from';
    if v_from is null or v_from not in ('user', 'operator') then return; end if;
    v_type := coalesce(d->>'type', 'text');
    v_ts := coalesce(to_timestamp((d->>'timestamp')::bigint / 1000.0), now());
    v_uid := d->'user'->>'user_id';
    v_nick := d->'user'->>'nickname';
    v_content := render_crisp_content(v_type, d->'content');
    v_bot := v_from = 'operator'
             and (detect_bot(v_ws, v_uid, v_nick) or (v_type = 'note' and starts_with(v_content, '🤖')));

    insert into messages (website_id, session_id, fingerprint, "from", type, operator_id, operator_name, is_bot, content, created_at)
    values (v_ws, v_sid, coalesce(d->>'fingerprint', md5(d::text)), v_from, v_type,
            case when v_from = 'operator' then v_uid end,
            case when v_from = 'operator' then v_nick end,
            v_bot, v_content, v_ts)
    on conflict (website_id, session_id, fingerprint)
      do update set content = excluded.content, is_bot = excluded.is_bot;

    if v_from = 'operator' and not v_bot and v_uid is not null then
      insert into operators (crisp_user_id, display_name) values (v_uid, v_nick)
      on conflict (crisp_user_id) do update set display_name = coalesce(operators.display_name, excluded.display_name);
      insert into operator_workspaces (crisp_user_id, website_id) values (v_uid, v_ws) on conflict do nothing;
    end if;

    update conversations c set
      last_customer_at = greatest(c.last_customer_at,
                                  case when v_from = 'user' then v_ts end),
      assigned_operator = case
                            when v_from = 'operator' and not v_bot and v_type not in ('note', 'event')
                                 and v_uid is not null
                                 and v_ts >= coalesce(c.last_human_operator_at, '-infinity'::timestamptz)
                            then v_uid else c.assigned_operator end,
      last_human_operator_at = greatest(c.last_human_operator_at,
                                        case when v_from = 'operator' and not v_bot and v_type not in ('note', 'event') then v_ts end),
      updated_at = now()
    where website_id = v_ws and session_id = v_sid;

  elsif v_ev in ('session:set_segments', 'session:set_state', 'session:set_email', 'session:meta') then
    update conversations c set
      segments = case when d ? 'segments' then array(select jsonb_array_elements_text(coalesce(d->'segments', '[]'::jsonb)))
                      else c.segments end,
      state = coalesce(d->>'state', c.state),
      resolved_at = case when d->>'state' = 'resolved' then coalesce(c.resolved_at, now())
                         when d->>'state' in ('pending', 'unresolved') then null
                         else c.resolved_at end,
      customer_email = coalesce(nullif(d->>'email', ''), c.customer_email),
      customer_name = coalesce(nullif(d->>'nickname', ''), c.customer_name),
      updated_at = now()
    where website_id = v_ws and session_id = v_sid;

    if d ? 'segments' then
      v_topic := resolve_topic_from_segments(
        (select topics from workspaces where website_id = v_ws),
        array(select jsonb_array_elements_text(coalesce(d->'segments', '[]'::jsonb))));
      update conversations set
        topic = case when v_topic is not null then v_topic
                     when topic_source = 'segment' then null else topic end,
        topic_source = case when v_topic is not null then 'segment'
                            when topic_source = 'segment' then null else topic_source end
      where website_id = v_ws and session_id = v_sid;
    end if;
  end if;
end $$;

create function public.ingest_events(p_events jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare e jsonb; n int := 0;
begin
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    perform ingest_event(e);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.ingest_event(jsonb) from public, anon, authenticated;
revoke execute on function public.ingest_events(jsonb) from public, anon, authenticated;
revoke execute on function public.detect_bot(text, text, text) from public, anon, authenticated;
grant execute on function public.ingest_event(jsonb) to service_role;
grant execute on function public.ingest_events(jsonb) to service_role;
```

- [ ] **Step 4: Áp migration và chạy test**

Run: `npm run db:reset && npm run db:test`
Expected: `config_test.sql .. ok`, `ingest_test.sql .. ok` (27/27).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261015000002_conversations.sql supabase/tests/ingest_test.sql
git commit -m "feat(db): conversations, messages and ingest_event RPC with bot detection"
```

---

### Task 4: Shared types + context (transcript, tin chưa trả lời)

**Files:**
- Create: `supabase/functions/_shared/types.ts`, `supabase/functions/_shared/context.ts`
- Test: `supabase/functions/tests/context.test.ts`

**Interfaces:**
- Produces (`types.ts`): `MessageRow`, `Topic`, `Workspace`, `Profile`, `ProfileRow`, `ConversationRow`.
- Produces (`context.ts`): `humanTranscript(messages: MessageRow[], maxLines?: number): string`, `unansweredCustomerMessages(messages: MessageRow[]): string[]`.

- [ ] **Step 1: Viết `types.ts`**

```ts
export interface MessageRow {
  from: "user" | "operator";
  type: string;
  is_bot: boolean;
  content: string;
  created_at: string;
  operator_name: string | null;
}

export interface Topic {
  key: string;
  label: string;
  segments: string[];
}

export interface Profile {
  tone: string;
  pronoun_self: string;
  pronoun_customer: string;
  use_emoji: boolean;
  signature: string | null;
  sample_messages: string[];
  style_notes: string | null;
}

export interface Workspace {
  website_id: string;
  name: string;
  topics: Topic[];
  default_profile: Partial<Profile>;
}

export interface ProfileRow extends Partial<Profile> {
  crisp_user_id: string;
  website_id: string;
  topic: string;
  conversations_used: number;
  learned_at: string | null;
  manual_override: Partial<Profile> | null;
}

export interface ConversationRow {
  website_id: string;
  session_id: string;
  customer_email: string | null;
  customer_name: string | null;
  topic: string | null;
  topic_source: "segment" | "ai" | null;
  state: string | null;
  last_customer_at: string | null;
  last_human_operator_at: string | null;
}
```

- [ ] **Step 2: Viết test (fail)**

`supabase/functions/tests/context.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { humanTranscript, unansweredCustomerMessages } from "../_shared/context.ts";
import type { MessageRow } from "../_shared/types.ts";

const m = (from: "user" | "operator", content: string, minute: number, extra: Partial<MessageRow> = {}): MessageRow => ({
  from,
  type: "text",
  is_bot: false,
  content,
  created_at: `2026-10-15T03:${String(minute).padStart(2, "0")}:00+00:00`,
  operator_name: from === "operator" ? "Lan" : null,
  ...extra,
});

Deno.test("humanTranscript drops bot messages and events, labels notes", () => {
  const out = humanTranscript([
    m("user", "Hi", 1),
    m("operator", "I am Mary", 2, { is_bot: true, operator_name: "Mary" }),
    m("operator", "check log", 3, { type: "note" }),
    m("operator", "", 4, { type: "event" }),
    m("operator", "Chào bạn", 5),
  ]);
  assertEquals(out, "Khách: Hi\nCS (Lan): [Ghi chú nội bộ] check log\nCS (Lan): Chào bạn");
});

Deno.test("humanTranscript sorts by time and keeps the last N lines", () => {
  const out = humanTranscript([m("user", "c", 3), m("user", "a", 1), m("user", "b", 2)], 2);
  assertEquals(out, "Khách: b\nKhách: c");
});

Deno.test("unanswered: trailing customer messages after last human reply", () => {
  assertEquals(
    unansweredCustomerMessages([m("user", "a", 1), m("operator", "b", 2), m("user", "c", 3), m("user", "d", 4)]),
    ["c", "d"],
  );
});

Deno.test("unanswered: bot replies do not count as answered", () => {
  assertEquals(
    unansweredCustomerMessages([m("user", "a", 1), m("operator", "bot", 2, { is_bot: true }), m("user", "c", 3)]),
    ["a", "c"],
  );
});

Deno.test("unanswered: internal notes do not count as a reply", () => {
  assertEquals(unansweredCustomerMessages([m("user", "a", 1), m("operator", "note", 2, { type: "note" })]), ["a"]);
});

Deno.test("unanswered: empty when a human CS replied last", () => {
  assertEquals(unansweredCustomerMessages([m("user", "a", 1), m("operator", "ok", 2)]), []);
});
```

- [ ] **Step 3: Chạy test, xác nhận fail**

Run: `deno test supabase/functions/tests/context.test.ts`
Expected: FAIL `Module not found ... context.ts`.

- [ ] **Step 4: Viết `context.ts`**

```ts
import type { MessageRow } from "./types.ts";

function byTime(messages: MessageRow[]): MessageRow[] {
  return [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

function isCustomerFacing(m: MessageRow): boolean {
  return m.type !== "note" && m.type !== "event";
}

/** Hội thoại dạng text cho prompt: bỏ tin bot và event, note ghi rõ là nội bộ. */
export function humanTranscript(messages: MessageRow[], maxLines = 40): string {
  const lines: string[] = [];
  for (const m of byTime(messages)) {
    if (m.is_bot || m.type === "event") continue;
    const who = m.from === "user" ? "Khách" : `CS${m.operator_name ? ` (${m.operator_name})` : ""}`;
    const body = m.type === "note" ? `[Ghi chú nội bộ] ${m.content}` : m.content;
    lines.push(`${who}: ${body.slice(0, 1500)}`);
  }
  return lines.slice(-maxLines).join("\n");
}

/** Các tin khách gửi liên tiếp sau lần cuối một CS người thật trả lời. Bot và note không tính là trả lời. */
export function unansweredCustomerMessages(messages: MessageRow[]): string[] {
  const real = byTime(messages).filter((m) => !m.is_bot && isCustomerFacing(m));
  const out: string[] = [];
  for (let i = real.length - 1; i >= 0 && real[i].from === "user"; i--) out.unshift(real[i].content);
  return out;
}
```

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `deno test supabase/functions/tests/context.test.ts`
Expected: `ok | 6 passed`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/types.ts supabase/functions/_shared/context.ts supabase/functions/tests/context.test.ts
git commit -m "feat(fn): shared types and conversation context helpers"
```

---

### Task 5: Chọn profile (fallback + manual override)

**Files:**
- Create: `supabase/functions/_shared/profile.ts`
- Test: `supabase/functions/tests/profile.test.ts`

**Interfaces:**
- Consumes: `Profile`, `ProfileRow` từ `types.ts`.
- Produces: `type ProfileSource = "topic" | "all" | "default"`, `BUILTIN_PROFILE: Profile`, `resolveProfile(rows: ProfileRow[], topic: string | null, workspaceDefault: Partial<Profile>): { profile: Profile; source: ProfileSource }`.

- [ ] **Step 1: Viết test (fail)**

`supabase/functions/tests/profile.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { BUILTIN_PROFILE, resolveProfile } from "../_shared/profile.ts";
import type { ProfileRow } from "../_shared/types.ts";

const row = (topic: string, extra: Partial<ProfileRow> = {}): ProfileRow => ({
  crisp_user_id: "op-lan",
  website_id: "ws1",
  topic,
  conversations_used: 10,
  learned_at: "2026-10-14T00:00:00Z",
  manual_override: null,
  ...extra,
});

Deno.test("no rows -> workspace default over builtin", () => {
  const r = resolveProfile([], "billing", { pronoun_customer: "anh/chị" });
  assertEquals(r.source, "default");
  assertEquals(r.profile, { ...BUILTIN_PROFILE, pronoun_customer: "anh/chị" });
});

Deno.test("topic row wins", () => {
  const r = resolveProfile([row("_all", { tone: "chung" }), row("billing", { tone: "chi tiết" })], "billing", {});
  assertEquals(r.source, "topic");
  assertEquals(r.profile.tone, "chi tiết");
});

Deno.test("missing topic row falls back to _all", () => {
  const r = resolveProfile([row("_all", { tone: "chung" })], "refund", {});
  assertEquals(r.source, "all");
  assertEquals(r.profile.tone, "chung");
});

Deno.test("null topic uses _all", () => {
  const r = resolveProfile([row("_all", { tone: "chung" }), row("billing", { tone: "x" })], null, {});
  assertEquals(r.source, "all");
});

Deno.test("manual_override beats learned values", () => {
  const r = resolveProfile([row("billing", { tone: "learned", manual_override: { tone: "lead set" } })], "billing", {});
  assertEquals(r.profile.tone, "lead set");
});

Deno.test("_all override applies to topic profiles, topic override wins over it", () => {
  const rows = [
    row("_all", { manual_override: { signature: "— Lan", use_emoji: false } }),
    row("billing", { use_emoji: true, manual_override: { use_emoji: true } }),
  ];
  const r = resolveProfile(rows, "billing", {});
  assertEquals(r.profile.signature, "— Lan");
  assertEquals(r.profile.use_emoji, true);
});

Deno.test("null learned fields do not erase defaults", () => {
  const r = resolveProfile([row("_all", { tone: undefined, pronoun_self: null as unknown as string })], null, { tone: "ws tone" });
  assertEquals(r.profile.tone, "ws tone");
  assertEquals(r.profile.pronoun_self, BUILTIN_PROFILE.pronoun_self);
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `deno test supabase/functions/tests/profile.test.ts`
Expected: FAIL `Module not found ... profile.ts`.

- [ ] **Step 3: Viết `profile.ts`**

```ts
import type { Profile, ProfileRow } from "./types.ts";

export type ProfileSource = "topic" | "all" | "default";

export const BUILTIN_PROFILE: Profile = {
  tone: "thân thiện, lịch sự, ngắn gọn",
  pronoun_self: "mình",
  pronoun_customer: "bạn",
  use_emoji: false,
  signature: null,
  sample_messages: [],
  style_notes: null,
};

const FIELDS = Object.keys(BUILTIN_PROFILE) as (keyof Profile)[];

function defined(p: Partial<Profile> | null | undefined): Partial<Profile> {
  const out: Partial<Profile> = {};
  if (!p) return out;
  for (const k of FIELDS) {
    const v = p[k];
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Thứ tự: CS × topic → CS × _all → mặc định workspace. manual_override (_all rồi tới topic) luôn thắng. */
export function resolveProfile(
  rows: ProfileRow[],
  topic: string | null,
  workspaceDefault: Partial<Profile>,
): { profile: Profile; source: ProfileSource } {
  const byTopic = topic ? rows.find((r) => r.topic === topic) : undefined;
  const all = rows.find((r) => r.topic === "_all");
  const picked = byTopic ?? all;
  const source: ProfileSource = byTopic ? "topic" : all ? "all" : "default";

  const profile: Profile = {
    ...BUILTIN_PROFILE,
    ...defined(workspaceDefault),
    ...defined(picked),
    ...defined(all?.manual_override),
    ...defined(byTopic?.manual_override),
  };
  return { profile, source };
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `deno test supabase/functions/tests/profile.test.ts`
Expected: `ok | 7 passed`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/profile.ts supabase/functions/tests/profile.test.ts
git commit -m "feat(fn): profile resolution with topic fallback and manual override"
```

---

### Task 6: Auth + client n8n

**Files:**
- Create: `supabase/functions/_shared/db.ts` (chỉ interface `Db` ở task này), `supabase/functions/_shared/auth.ts`, `supabase/functions/_shared/n8n.ts`
- Test: `supabase/functions/tests/auth.test.ts`, `supabase/functions/tests/n8n.test.ts`

**Interfaces:**
- Produces (`db.ts`):
  ```ts
  export interface Db {
    getWorkspace(websiteId: string): Promise<Workspace | null>;
    getOperatorIdByTokenHash(tokenHash: string): Promise<string | null>;
    isOperatorMember(operatorId: string, websiteId: string): Promise<boolean>;
    getConversation(websiteId: string, sessionId: string): Promise<ConversationRow | null>;
    getMessages(websiteId: string, sessionId: string, limit: number): Promise<MessageRow[]>;
    getProfiles(operatorId: string, websiteId: string): Promise<ProfileRow[]>;
    getOperator(operatorId: string): Promise<{ display_name: string | null } | null>;
  }
  ```
- Produces (`auth.ts`): `class HttpError extends Error { status: number }`, `sha256Hex(s: string): Promise<string>`, `authorize(db: Db, req: { website_id: string; token: string }): Promise<{ workspace: Workspace; operatorId: string }>`.
- Produces (`n8n.ts`): `interface N8n { refreshConversation(websiteId: string, sessionId: string): Promise<{ stale: boolean }>; postNote(websiteId: string, sessionId: string, content: string): Promise<boolean> }`, `createN8n(opts: { baseUrl: string; secret: string; fetch?: typeof fetch; refreshTimeoutMs?: number }): N8n`. Endpoint: `POST {baseUrl}/copilot-refresh` body `{website_id, session_id}`, `POST {baseUrl}/copilot-post-note` body `{website_id, session_id, content}`, cả hai có header `x-copilot-secret`.

- [ ] **Step 1: Viết interface `Db`**

`supabase/functions/_shared/db.ts`:

```ts
import type { ConversationRow, MessageRow, ProfileRow, Workspace } from "./types.ts";

export interface Db {
  getWorkspace(websiteId: string): Promise<Workspace | null>;
  getOperatorIdByTokenHash(tokenHash: string): Promise<string | null>;
  isOperatorMember(operatorId: string, websiteId: string): Promise<boolean>;
  getConversation(websiteId: string, sessionId: string): Promise<ConversationRow | null>;
  getMessages(websiteId: string, sessionId: string, limit: number): Promise<MessageRow[]>;
  getProfiles(operatorId: string, websiteId: string): Promise<ProfileRow[]>;
  getOperator(operatorId: string): Promise<{ display_name: string | null } | null>;
}
```

- [ ] **Step 2: Viết test auth (fail)**

`supabase/functions/tests/auth.test.ts`:

```ts
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { authorize, HttpError, sha256Hex } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { Workspace } from "../_shared/types.ts";

const WS: Workspace = { website_id: "ws1", name: "App A", topics: [], default_profile: {} };
const TOKEN = "tok-lan";

async function fakeDb(member = true): Promise<Db> {
  const lanHash = await sha256Hex(TOKEN);
  return {
    getWorkspace: (id) => Promise.resolve(id === "ws1" ? WS : null),
    getOperatorIdByTokenHash: (h) => Promise.resolve(h === lanHash ? "op-lan" : null),
    isOperatorMember: () => Promise.resolve(member),
    getConversation: () => Promise.resolve(null),
    getMessages: () => Promise.resolve([]),
    getProfiles: () => Promise.resolve([]),
    getOperator: () => Promise.resolve(null),
  };
}

async function status(p: Promise<unknown>): Promise<number> {
  const e = await assertRejects(() => p, HttpError);
  return (e as HttpError).status;
}

Deno.test("sha256Hex matches known vector", async () => {
  assertEquals(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

Deno.test("missing token -> 401", async () => {
  assertEquals(await status(authorize(await fakeDb(), { website_id: "ws1", token: "" })), 401);
});

Deno.test("missing website_id -> 400", async () => {
  assertEquals(await status(authorize(await fakeDb(), { website_id: "", token: TOKEN })), 400);
});

Deno.test("unknown token -> 401", async () => {
  assertEquals(await status(authorize(await fakeDb(), { website_id: "ws1", token: "stolen?" })), 401);
});

Deno.test("unknown workspace -> 404", async () => {
  assertEquals(await status(authorize(await fakeDb(), { website_id: "nope", token: TOKEN })), 404);
});

Deno.test("operator not in workspace -> 403", async () => {
  assertEquals(await status(authorize(await fakeDb(false), { website_id: "ws1", token: TOKEN })), 403);
});

Deno.test("valid token returns workspace and operator", async () => {
  assertEquals(await authorize(await fakeDb(), { website_id: "ws1", token: TOKEN }), { workspace: WS, operatorId: "op-lan" });
});
```

- [ ] **Step 3: Viết test n8n (fail)**

`supabase/functions/tests/n8n.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { createN8n } from "../_shared/n8n.ts";

type Call = { url: string; init: RequestInit };

function recorder(response: () => Promise<Response>) {
  const calls: Call[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, f };
}

Deno.test("refresh ok -> stale false, sends secret and ids", async () => {
  const { calls, f } = recorder(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.refreshConversation("ws1", "session_1"), { stale: false });
  assertEquals(calls[0].url, "https://n8n.test/webhook/copilot-refresh");
  assertEquals((calls[0].init.headers as Record<string, string>)["x-copilot-secret"], "k");
  assertEquals(JSON.parse(calls[0].init.body as string), { website_id: "ws1", session_id: "session_1" });
});

Deno.test("refresh non-2xx -> stale true", async () => {
  const { f } = recorder(() => Promise.resolve(new Response("err", { status: 500 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.refreshConversation("ws1", "session_1"), { stale: true });
});

Deno.test("refresh hang -> stale true after timeout", async () => {
  const hanging = ((_u: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    )) as typeof fetch;
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: hanging, refreshTimeoutMs: 50 });
  const t0 = Date.now();
  assertEquals(await n8n.refreshConversation("ws1", "session_1"), { stale: true });
  assertEquals(Date.now() - t0 < 1000, true);
});

Deno.test("postNote prefixes robot once and returns ok", async () => {
  const { calls, f } = recorder(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.postNote("ws1", "session_1", "Tóm tắt"), true);
  assertEquals(await n8n.postNote("ws1", "session_1", "🤖 Đã có"), true);
  assertEquals(calls[0].url, "https://n8n.test/webhook/copilot-post-note");
  assertEquals(JSON.parse(calls[0].init.body as string).content, "🤖 Tóm tắt");
  assertEquals(JSON.parse(calls[1].init.body as string).content, "🤖 Đã có");
});

Deno.test("postNote network error -> false", async () => {
  const { f } = recorder(() => Promise.reject(new TypeError("network")));
  const n8n = createN8n({ baseUrl: "https://n8n.test/webhook", secret: "k", fetch: f });
  assertEquals(await n8n.postNote("ws1", "session_1", "x"), false);
});
```

- [ ] **Step 4: Chạy test, xác nhận fail**

Run: `deno test supabase/functions/tests/auth.test.ts supabase/functions/tests/n8n.test.ts`
Expected: FAIL `Module not found ... auth.ts` / `n8n.ts`.

- [ ] **Step 5: Viết `auth.ts`**

```ts
import type { Db } from "./db.ts";
import type { Workspace } from "./types.ts";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Token cá nhân → operator; operator phải thuộc workspace đang mở. */
export async function authorize(
  db: Db,
  req: { website_id: string; token: string },
): Promise<{ workspace: Workspace; operatorId: string }> {
  if (!req.token) throw new HttpError(401, "Thiếu token, nhập token trong Options của extension");
  if (!req.website_id) throw new HttpError(400, "Thiếu website_id");
  const operatorId = await db.getOperatorIdByTokenHash(await sha256Hex(req.token));
  if (!operatorId) throw new HttpError(401, "Token không hợp lệ");
  const workspace = await db.getWorkspace(req.website_id);
  if (!workspace) throw new HttpError(404, "Workspace này chưa được cấu hình trong copilot");
  if (!(await db.isOperatorMember(operatorId, req.website_id))) {
    throw new HttpError(403, "CS không thuộc workspace này");
  }
  return { workspace, operatorId };
}
```

- [ ] **Step 6: Viết `n8n.ts`**

```ts
export interface N8n {
  refreshConversation(websiteId: string, sessionId: string): Promise<{ stale: boolean }>;
  postNote(websiteId: string, sessionId: string, content: string): Promise<boolean>;
}

const BOT_MARK = "🤖";

export function createN8n(opts: {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
  refreshTimeoutMs?: number;
}): N8n {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.refreshTimeoutMs ?? 3000;

  function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return doFetch(`${opts.baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-copilot-secret": opts.secret },
      body: JSON.stringify(body),
      signal,
    });
  }

  return {
    async refreshConversation(websiteId, sessionId) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await post("copilot-refresh", { website_id: websiteId, session_id: sessionId }, ctrl.signal);
        await res.body?.cancel();
        return { stale: !res.ok };
      } catch {
        return { stale: true };
      } finally {
        clearTimeout(timer);
      }
    },

    async postNote(websiteId, sessionId, content) {
      const text = content.startsWith(BOT_MARK) ? content : `${BOT_MARK} ${content}`;
      try {
        const res = await post("copilot-post-note", { website_id: websiteId, session_id: sessionId, content: text });
        await res.body?.cancel();
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
```

- [ ] **Step 7: Chạy test, xác nhận pass**

Run: `deno test supabase/functions/tests/auth.test.ts supabase/functions/tests/n8n.test.ts`
Expected: `ok | 12 passed`.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/_shared/db.ts supabase/functions/_shared/auth.ts supabase/functions/_shared/n8n.ts supabase/functions/tests/auth.test.ts supabase/functions/tests/n8n.test.ts
git commit -m "feat(fn): per-operator token auth and n8n gateway client"
```

---

### Task 7: Edge Function `copilot` với action `check`

**Files:**
- Modify: `supabase/functions/_shared/db.ts` (thêm `createDb`)
- Create: `supabase/functions/copilot/handler.ts`, `supabase/functions/copilot/index.ts`
- Test: `supabase/functions/tests/handler.test.ts`

**Interfaces:**
- Consumes: `Db`, `authorize`, `HttpError`, `N8n`, `resolveProfile`, `unansweredCustomerMessages`.
- Produces:
  - `handle(body: unknown, token: string, deps: { db: Db; n8n: N8n }): Promise<{ status: number; body: unknown }>`.
  - HTTP: header `x-copilot-token`; body `{ website_id, session_id, action: "check" | "handoff" | "generate", force?: boolean }`.
  - Response `check`: `CheckResult` (dưới). Plan 2 thêm `handoff`/`generate`, Plan 3 điền `jira`.

- [ ] **Step 1: Viết test (fail)**

`supabase/functions/tests/handler.test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { sha256Hex } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";
import type { ConversationRow, MessageRow, ProfileRow, Workspace } from "../_shared/types.ts";

const WS: Workspace = {
  website_id: "ws1",
  name: "App A",
  topics: [{ key: "billing", label: "Billing", segments: ["billing"] }],
  default_profile: {},
};
const CONV: ConversationRow = {
  website_id: "ws1",
  session_id: "session_1",
  customer_email: "k@x.io",
  customer_name: "Khách",
  topic: "billing",
  topic_source: "segment",
  state: "unresolved",
  last_customer_at: "2026-10-15T03:03:00+00:00",
  last_human_operator_at: "2026-10-15T03:02:00+00:00",
};
const MSGS: MessageRow[] = [
  { from: "user", type: "text", is_bot: false, content: "a", created_at: "2026-10-15T03:01:00+00:00", operator_name: null },
  { from: "operator", type: "text", is_bot: false, content: "b", created_at: "2026-10-15T03:02:00+00:00", operator_name: "Lan" },
  { from: "user", type: "text", is_bot: false, content: "c", created_at: "2026-10-15T03:03:00+00:00", operator_name: null },
];
const PROFILES: ProfileRow[] = [
  { crisp_user_id: "op-lan", website_id: "ws1", topic: "billing", tone: "chi tiết", conversations_used: 9, learned_at: null, manual_override: null },
];

const TOKEN = "tok-lan";
const TOKEN_HASH = await sha256Hex(TOKEN);

function deps(over: Partial<Db> = {}, stale = false) {
  const db: Db = {
    getWorkspace: () => Promise.resolve(WS),
    getOperatorIdByTokenHash: (h) => Promise.resolve(h === TOKEN_HASH ? "op-lan" : null),
    isOperatorMember: () => Promise.resolve(true),
    getConversation: () => Promise.resolve(CONV),
    getMessages: () => Promise.resolve(MSGS),
    getProfiles: () => Promise.resolve(PROFILES),
    getOperator: () => Promise.resolve({ display_name: "Lan Nguyen" }),
    ...over,
  };
  const n8n: N8n = {
    refreshConversation: () => Promise.resolve({ stale }),
    postNote: () => Promise.resolve(true),
  };
  return { db, n8n };
}

const REQ = { website_id: "ws1", session_id: "session_1", action: "check" };

Deno.test("check returns unanswered, topic and profile", async () => {
  const r = await handle(REQ, TOKEN, deps());
  assertEquals(r.status, 200);
  assertEquals(r.body, {
    action: "check",
    stale: false,
    workspace: "App A",
    topic: "billing",
    topic_label: "Billing",
    profile_source: "topic",
    profile_name: "Lan Nguyen",
    needs_reply: true,
    unanswered: ["c"],
    last_customer_at: CONV.last_customer_at,
    last_human_operator_at: CONV.last_human_operator_at,
    jira: [],
  });
});

Deno.test("check passes through stale flag", async () => {
  const r = await handle(REQ, TOKEN, deps({}, true));
  assertEquals((r.body as { stale: boolean }).stale, true);
});

Deno.test("unknown action -> 400", async () => {
  assertEquals((await handle({ ...REQ, action: "delete" }, TOKEN, deps())).status, 400);
});

Deno.test("handoff not available yet -> 501", async () => {
  assertEquals((await handle({ ...REQ, action: "handoff" }, TOKEN, deps())).status, 501);
});

Deno.test("missing session_id -> 400", async () => {
  assertEquals((await handle({ ...REQ, session_id: "" }, TOKEN, deps())).status, 400);
});

Deno.test("non-object body -> 400", async () => {
  assertEquals((await handle("nope", TOKEN, deps())).status, 400);
});

Deno.test("conversation not in DB -> 404", async () => {
  assertEquals((await handle(REQ, TOKEN, deps({ getConversation: () => Promise.resolve(null) }))).status, 404);
});

Deno.test("bad token -> 401", async () => {
  assertEquals((await handle(REQ, "wrong!", deps())).status, 401);
});

Deno.test("unexpected error -> 500 without leaking details", async () => {
  const r = await handle(REQ, TOKEN, deps({ getMessages: () => Promise.reject(new Error("db password=xyz")) }));
  assertEquals(r.status, 500);
  assertEquals(r.body, { error: "Lỗi hệ thống, thử lại sau" });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `deno test supabase/functions/tests/handler.test.ts`
Expected: FAIL `Module not found ... handler.ts`.

- [ ] **Step 3: Viết `handler.ts`**

```ts
import { authorize, HttpError } from "../_shared/auth.ts";
import { unansweredCustomerMessages } from "../_shared/context.ts";
import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";
import { type ProfileSource, resolveProfile } from "../_shared/profile.ts";

const ACTIONS = ["check", "handoff", "generate"] as const;
type Action = typeof ACTIONS[number];
const MESSAGE_LIMIT = 60;

export interface CopilotRequest {
  website_id: string;
  session_id: string;
  action: Action;
  force: boolean;
}

export interface CheckResult {
  action: "check";
  stale: boolean;
  workspace: string;
  topic: string | null;
  topic_label: string | null;
  profile_source: ProfileSource;
  profile_name: string;
  needs_reply: boolean;
  unanswered: string[];
  last_customer_at: string | null;
  last_human_operator_at: string | null;
  jira: unknown[];
}

function parseRequest(body: unknown): CopilotRequest {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Body phải là JSON object");
  const b = body as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  const action = str("action") as Action;
  if (!ACTIONS.includes(action)) throw new HttpError(400, `action không hợp lệ: ${str("action")}`);
  if (!str("session_id")) throw new HttpError(400, "Thiếu session_id");
  return {
    website_id: str("website_id"),
    session_id: str("session_id"),
    action,
    force: b.force === true || b.force === "1",
  };
}

export async function handle(
  body: unknown,
  token: string,
  deps: { db: Db; n8n: N8n },
): Promise<{ status: number; body: unknown }> {
  try {
    const req = parseRequest(body);
    const { workspace: ws, operatorId } = await authorize(deps.db, { website_id: req.website_id, token });
    if (req.action !== "check") throw new HttpError(501, `Chức năng ${req.action} chưa có`);

    const { stale } = await deps.n8n.refreshConversation(req.website_id, req.session_id);
    const conv = await deps.db.getConversation(req.website_id, req.session_id);
    if (!conv) throw new HttpError(404, "Chưa có dữ liệu conversation này");

    const [messages, profiles, operator] = await Promise.all([
      deps.db.getMessages(req.website_id, req.session_id, MESSAGE_LIMIT),
      deps.db.getProfiles(operatorId, req.website_id),
      deps.db.getOperator(operatorId),
    ]);
    const unanswered = unansweredCustomerMessages(messages);
    const { source } = resolveProfile(profiles, conv.topic, ws.default_profile);

    const result: CheckResult = {
      action: "check",
      stale,
      workspace: ws.name,
      topic: conv.topic,
      topic_label: ws.topics.find((t) => t.key === conv.topic)?.label ?? null,
      profile_source: source,
      profile_name: operator?.display_name ?? operatorId,
      needs_reply: unanswered.length > 0,
      unanswered,
      last_customer_at: conv.last_customer_at,
      last_human_operator_at: conv.last_human_operator_at,
      jira: [],
    };
    return { status: 200, body: result };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
    console.error("copilot error", e);
    return { status: 500, body: { error: "Lỗi hệ thống, thử lại sau" } };
  }
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `deno test supabase/functions/tests/handler.test.ts`
Expected: `ok | 9 passed`.

- [ ] **Step 5: Thêm adapter `createDb` vào `db.ts`**

Thêm vào cuối `supabase/functions/_shared/db.ts`:

```ts
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export function createDb(sb: SupabaseClient): Db {
  return {
    async getWorkspace(websiteId) {
      const { data, error } = await sb.from("workspaces")
        .select("website_id,name,topics,default_profile")
        .eq("website_id", websiteId).maybeSingle();
      if (error) throw error;
      return data as Workspace | null;
    },
    async getOperatorIdByTokenHash(tokenHash) {
      const { data, error } = await sb.from("operators").select("crisp_user_id")
        .eq("copilot_token_hash", tokenHash).maybeSingle();
      if (error) throw error;
      return (data?.crisp_user_id as string | undefined) ?? null;
    },
    async isOperatorMember(operatorId, websiteId) {
      const { data, error } = await sb.from("operator_workspaces").select("active")
        .eq("crisp_user_id", operatorId).eq("website_id", websiteId).maybeSingle();
      if (error) throw error;
      return data?.active === true;
    },
    async getConversation(websiteId, sessionId) {
      const { data, error } = await sb.from("conversations")
        .select("website_id,session_id,customer_email,customer_name,topic,topic_source,state,last_customer_at,last_human_operator_at")
        .eq("website_id", websiteId).eq("session_id", sessionId).maybeSingle();
      if (error) throw error;
      return data as ConversationRow | null;
    },
    async getMessages(websiteId, sessionId, limit) {
      const { data, error } = await sb.from("messages")
        .select("from,type,is_bot,content,created_at,operator_name")
        .eq("website_id", websiteId).eq("session_id", sessionId)
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return ((data ?? []) as MessageRow[]).reverse();
    },
    async getProfiles(operatorId, websiteId) {
      const { data, error } = await sb.from("agent_profiles").select("*")
        .eq("crisp_user_id", operatorId).eq("website_id", websiteId);
      if (error) throw error;
      return (data ?? []) as ProfileRow[];
    },
    async getOperator(operatorId) {
      const { data, error } = await sb.from("operators").select("display_name")
        .eq("crisp_user_id", operatorId).maybeSingle();
      if (error) throw error;
      return data as { display_name: string | null } | null;
    },
  };
}
```

Đưa dòng `import type { SupabaseClient } ...` lên đầu file, cạnh import `types.ts`.

- [ ] **Step 6: Viết `index.ts`**

`supabase/functions/copilot/index.ts`:

```ts
import { createClient } from "npm:@supabase/supabase-js@2";
import { createDb } from "../_shared/db.ts";
import { createN8n } from "../_shared/n8n.ts";
import { handle } from "./handler.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-copilot-token",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

const db = createDb(createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!));
const n8n = createN8n({ baseUrl: Deno.env.get("N8N_WEBHOOK_BASE")!, secret: Deno.env.get("N8N_SHARED_SECRET")! });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Chỉ hỗ trợ POST" });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body không phải JSON" });
  }
  const r = await handle(body, req.headers.get("x-copilot-token") ?? "", { db, n8n });
  return json(r.status, r.body);
});
```

- [ ] **Step 7: Type-check + toàn bộ test**

Run: `deno check supabase/functions/copilot/index.ts && deno task test`
Expected: không lỗi type, mọi test pass.

- [ ] **Step 8: Smoke test local**

Seed dữ liệu (Git Bash):

```bash
docker exec -i supabase_db_cs-copilot psql -U postgres -d postgres <<'SQL'
insert into workspaces (website_id, name, topics)
values ('ws-local', 'Local', '[{"key":"billing","label":"Billing","segments":["billing"]}]')
on conflict do nothing;
select ingest_events('[
 {"website_id":"ws-local","event":"message:send","data":{"session_id":"session_x","fingerprint":1,"from":"user","type":"text","content":"Tôi bị trừ tiền 2 lần","timestamp":1760500000000}},
 {"website_id":"ws-local","event":"message:received","data":{"session_id":"session_x","fingerprint":2,"from":"operator","type":"text","content":"Mình kiểm tra ngay","user":{"user_id":"op-local","nickname":"Lan"},"timestamp":1760500060000}},
 {"website_id":"ws-local","event":"message:send","data":{"session_id":"session_x","fingerprint":3,"from":"user","type":"text","content":"Sao rồi bạn?","timestamp":1760500120000}},
 {"website_id":"ws-local","event":"session:set_segments","data":{"session_id":"session_x","segments":["billing"]}}
]'::jsonb);
update operators set copilot_token_hash = encode(extensions.digest('local-token', 'sha256'), 'hex')
where crisp_user_id = 'op-local';
SQL
```

Chạy function (terminal riêng): `npx supabase functions serve copilot --env-file supabase/functions/.env`

Gọi:

```bash
curl -s -X POST http://127.0.0.1:54321/functions/v1/copilot \
  -H 'content-type: application/json' -H 'x-copilot-token: local-token' \
  -d '{"website_id":"ws-local","session_id":"session_x","action":"check"}'
```

Expected: HTTP 200, JSON có `"stale":true` (n8n chưa chạy), `"topic":"billing"`, `"unanswered":["Sao rồi bạn?"]`, `"profile_source":"default"`, `"profile_name":"Lan"`.

- [ ] **Step 9: Commit**

```bash
git add supabase/functions/_shared/db.ts supabase/functions/copilot/ supabase/functions/tests/handler.test.ts
git commit -m "feat(fn): copilot edge function with check action"
```

---

### Task 8: Workflow n8n (I/O) + kiểm tra cấu trúc

**Files:**
- Create: `n8n/ingest-crisp.json`, `n8n/copilot-refresh.json`, `n8n/copilot-post-note.json`, `n8n/crisp-sync.json`
- Test: `n8n/validate.test.ts`

**Interfaces:**
- Consumes: RPC `ingest_event` / `ingest_events` (Task 3), contract webhook của `n8n.ts` (Task 6): `POST /webhook/copilot-refresh`, `POST /webhook/copilot-post-note`, header `x-copilot-secret`.
- Produces: 4 workflow import được vào n8n. Placeholder cần thay khi import: `https://YOUR-PROJECT.supabase.co`, `REPLACE_N8N_SHARED_SECRET`, `crisp-ingest-REPLACE-WITH-RANDOM`, credential `REPLACE_SUPABASE` (Custom Auth `{"headers":{"apikey":"<service_role>","Authorization":"Bearer <service_role>"}}`), `REPLACE_CRISP` (Basic Auth plugin token).

- [ ] **Step 1: Viết test cấu trúc (fail)**

`n8n/validate.test.ts`:

```ts
import { assert, assertEquals } from "jsr:@std/assert@1";

const FILES = ["ingest-crisp.json", "copilot-refresh.json", "copilot-post-note.json", "crisp-sync.json"];
const dir = new URL(".", import.meta.url);

interface Node { name: string; type: string; typeVersion: number; parameters: Record<string, unknown>; credentials?: Record<string, { id: string }> }
interface Wf { name: string; nodes: Node[]; connections: Record<string, { main: { node: string }[][] }> }

for (const file of FILES) {
  Deno.test(`${file}: valid workflow structure`, async () => {
    const wf: Wf = JSON.parse(await Deno.readTextFile(new URL(file, dir)));
    const names = wf.nodes.map((n) => n.name);
    assertEquals(new Set(names).size, names.length, "node names must be unique");
    for (const n of wf.nodes) assert(n.type && n.typeVersion, `${n.name} missing type/typeVersion`);
    for (const [src, conn] of Object.entries(wf.connections)) {
      assert(names.includes(src), `connection source ${src} not a node`);
      for (const branch of conn.main) for (const t of branch) assert(names.includes(t.node), `target ${t.node} not a node`);
    }
    for (const n of wf.nodes) {
      for (const c of Object.values(n.credentials ?? {})) assert(c.id.startsWith("REPLACE_"), `${n.name} has a real credential id`);
    }
    const needsResponder = wf.nodes.some((n) => n.type === "n8n-nodes-base.webhook" && n.parameters.responseMode === "responseNode");
    if (needsResponder) assert(wf.nodes.some((n) => n.type === "n8n-nodes-base.respondToWebhook"), "missing Respond to Webhook");
  });
}
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `deno test --allow-read n8n/validate.test.ts`
Expected: FAIL `NotFound ... ingest-crisp.json`.

Cập nhật task trong `deno.json`, vì test này cần đọc file:

```json
{
  "tasks": {
    "test": "deno test --allow-read supabase/functions/tests n8n"
  }
}
```

- [ ] **Step 3: Viết `n8n/ingest-crisp.json`**

```json
{
  "name": "Copilot v5 — Ingest Crisp",
  "nodes": [
    {
      "parameters": { "httpMethod": "POST", "path": "crisp-ingest-REPLACE-WITH-RANDOM", "responseMode": "onReceived", "options": {} },
      "id": "b1a00000-0000-4000-8000-000000000001",
      "name": "Crisp Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 0],
      "webhookId": "b1a00000-0000-4000-8000-0000000000a1"
    },
    {
      "parameters": {
        "jsCode": "// Chỉ chuyển tiếp event cần thiết. Mọi chuẩn hoá nằm trong RPC ingest_event.\nconst ALLOWED = ['message:send', 'message:received', 'session:set_segments', 'session:set_state', 'session:set_email'];\nconst b = $input.first().json.body || {};\nif (!ALLOWED.includes(b.event) || !b.website_id || !b.data) return [];\nreturn [{ json: { p_event: { website_id: b.website_id, event: b.event, data: b.data } } }];"
      },
      "id": "b1a00000-0000-4000-8000-000000000002",
      "name": "Filter Events",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [220, 0]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://YOUR-PROJECT.supabase.co/rest/v1/rpc/ingest_event",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpCustomAuth",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ p_event: $json.p_event }) }}",
        "options": { "timeout": 15000 }
      },
      "id": "b1a00000-0000-4000-8000-000000000003",
      "name": "Ingest Event",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [440, 0],
      "credentials": { "httpCustomAuth": { "id": "REPLACE_SUPABASE", "name": "Supabase Service Key" } },
      "retryOnFail": true,
      "maxTries": 3,
      "waitBetweenTries": 2000
    }
  ],
  "connections": {
    "Crisp Webhook": { "main": [[{ "node": "Filter Events", "type": "main", "index": 0 }]] },
    "Filter Events": { "main": [[{ "node": "Ingest Event", "type": "main", "index": 0 }]] }
  },
  "active": false,
  "settings": { "executionOrder": "v1" }
}
```

- [ ] **Step 4: Viết `n8n/copilot-refresh.json`**

```json
{
  "name": "Copilot v5 — Refresh Conversation",
  "nodes": [
    {
      "parameters": { "httpMethod": "POST", "path": "copilot-refresh", "responseMode": "responseNode", "options": {} },
      "id": "b2a00000-0000-4000-8000-000000000001",
      "name": "Refresh Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 0],
      "webhookId": "b2a00000-0000-4000-8000-0000000000a1"
    },
    {
      "parameters": {
        "jsCode": "const SECRET = 'REPLACE_N8N_SHARED_SECRET';\nconst req = $input.first().json;\nif ((req.headers || {})['x-copilot-secret'] !== SECRET) throw new Error('unauthorized');\nconst { website_id, session_id } = req.body || {};\nif (!/^[\\w-]+$/.test(website_id || '') || !/^session_[\\w-]+$/.test(session_id || '')) throw new Error('bad input');\nreturn [{ json: { website_id, session_id } }];"
      },
      "id": "b2a00000-0000-4000-8000-000000000002",
      "name": "Verify Secret",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [220, 0]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "=https://api.crisp.chat/v1/website/{{ $json.website_id }}/conversation/{{ $json.session_id }}",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpBasicAuth",
        "sendHeaders": true,
        "headerParameters": { "parameters": [{ "name": "X-Crisp-Tier", "value": "plugin" }] },
        "options": { "timeout": 8000 }
      },
      "id": "b2a00000-0000-4000-8000-000000000003",
      "name": "Get Conversation",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [440, 0],
      "credentials": { "httpBasicAuth": { "id": "REPLACE_CRISP", "name": "Crisp Plugin Token" } }
    },
    {
      "parameters": {
        "method": "GET",
        "url": "=https://api.crisp.chat/v1/website/{{ $('Verify Secret').first().json.website_id }}/conversation/{{ $('Verify Secret').first().json.session_id }}/messages",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpBasicAuth",
        "sendHeaders": true,
        "headerParameters": { "parameters": [{ "name": "X-Crisp-Tier", "value": "plugin" }] },
        "options": { "timeout": 8000 }
      },
      "id": "b2a00000-0000-4000-8000-000000000004",
      "name": "Get Messages",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [660, 0],
      "credentials": { "httpBasicAuth": { "id": "REPLACE_CRISP", "name": "Crisp Plugin Token" } }
    },
    {
      "parameters": {
        "jsCode": "const { website_id, session_id } = $('Verify Secret').first().json;\nconst conv = $('Get Conversation').first().json.data || {};\nconst meta = conv.meta || {};\nconst raw = $('Get Messages').first().json.data;\nconst msgs = Array.isArray(raw) ? raw : [];\nconst events = [{ website_id, event: 'session:meta', data: { session_id, email: meta.email || null, nickname: meta.nickname || null, segments: meta.segments || [], state: conv.state || null } }];\nfor (const m of msgs) events.push({ website_id, event: 'message:import', data: { ...m, session_id } });\nreturn [{ json: { p_events: events } }];"
      },
      "id": "b2a00000-0000-4000-8000-000000000005",
      "name": "Build Events",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [880, 0]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://YOUR-PROJECT.supabase.co/rest/v1/rpc/ingest_events",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpCustomAuth",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ p_events: $json.p_events }) }}",
        "options": { "timeout": 8000 }
      },
      "id": "b2a00000-0000-4000-8000-000000000006",
      "name": "Ingest Events",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1100, 0],
      "credentials": { "httpCustomAuth": { "id": "REPLACE_SUPABASE", "name": "Supabase Service Key" } }
    },
    {
      "parameters": { "respondWith": "json", "responseBody": "{\"ok\": true}", "options": {} },
      "id": "b2a00000-0000-4000-8000-000000000007",
      "name": "Respond OK",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "position": [1320, 0]
    }
  ],
  "connections": {
    "Refresh Webhook": { "main": [[{ "node": "Verify Secret", "type": "main", "index": 0 }]] },
    "Verify Secret": { "main": [[{ "node": "Get Conversation", "type": "main", "index": 0 }]] },
    "Get Conversation": { "main": [[{ "node": "Get Messages", "type": "main", "index": 0 }]] },
    "Get Messages": { "main": [[{ "node": "Build Events", "type": "main", "index": 0 }]] },
    "Build Events": { "main": [[{ "node": "Ingest Events", "type": "main", "index": 0 }]] },
    "Ingest Events": { "main": [[{ "node": "Respond OK", "type": "main", "index": 0 }]] }
  },
  "active": false,
  "settings": { "executionOrder": "v1" }
}
```

- [ ] **Step 5: Viết `n8n/copilot-post-note.json`**

```json
{
  "name": "Copilot v5 — Post Note",
  "nodes": [
    {
      "parameters": { "httpMethod": "POST", "path": "copilot-post-note", "responseMode": "responseNode", "options": {} },
      "id": "b3a00000-0000-4000-8000-000000000001",
      "name": "Post Note Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 0],
      "webhookId": "b3a00000-0000-4000-8000-0000000000a1"
    },
    {
      "parameters": {
        "jsCode": "const SECRET = 'REPLACE_N8N_SHARED_SECRET';\nconst req = $input.first().json;\nif ((req.headers || {})['x-copilot-secret'] !== SECRET) throw new Error('unauthorized');\nconst { website_id, session_id, content } = req.body || {};\nif (!/^[\\w-]+$/.test(website_id || '') || !/^session_[\\w-]+$/.test(session_id || '')) throw new Error('bad input');\nif (typeof content !== 'string' || !content.trim()) throw new Error('empty content');\nreturn [{ json: { website_id, session_id, content: content.slice(0, 9000) } }];"
      },
      "id": "b3a00000-0000-4000-8000-000000000002",
      "name": "Verify Secret",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [220, 0]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "=https://api.crisp.chat/v1/website/{{ $json.website_id }}/conversation/{{ $json.session_id }}/message",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpBasicAuth",
        "sendHeaders": true,
        "headerParameters": { "parameters": [{ "name": "X-Crisp-Tier", "value": "plugin" }] },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ type: 'note', from: 'operator', origin: 'chat', content: $json.content }) }}",
        "options": { "timeout": 10000 }
      },
      "id": "b3a00000-0000-4000-8000-000000000003",
      "name": "Post Note to Crisp",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [440, 0],
      "credentials": { "httpBasicAuth": { "id": "REPLACE_CRISP", "name": "Crisp Plugin Token" } }
    },
    {
      "parameters": { "respondWith": "json", "responseBody": "{\"ok\": true}", "options": {} },
      "id": "b3a00000-0000-4000-8000-000000000004",
      "name": "Respond OK",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "position": [660, 0]
    }
  ],
  "connections": {
    "Post Note Webhook": { "main": [[{ "node": "Verify Secret", "type": "main", "index": 0 }]] },
    "Verify Secret": { "main": [[{ "node": "Post Note to Crisp", "type": "main", "index": 0 }]] },
    "Post Note to Crisp": { "main": [[{ "node": "Respond OK", "type": "main", "index": 0 }]] }
  },
  "active": false,
  "settings": { "executionOrder": "v1" }
}
```

- [ ] **Step 6: Viết `n8n/crisp-sync.json`** (đồng bộ operator + reconcile/backfill)

```json
{
  "name": "Copilot v5 — Crisp Sync (operators + reconcile/backfill)",
  "nodes": [
    {
      "parameters": { "rule": { "interval": [{ "field": "days", "triggerAtHour": 2 }] } },
      "id": "b4a00000-0000-4000-8000-000000000001",
      "name": "Nightly",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [0, 0]
    },
    {
      "parameters": {},
      "id": "b4a00000-0000-4000-8000-000000000002",
      "name": "Run Manually",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 200]
    },
    {
      "parameters": {
        "jsCode": "// Lần đầu: đổi DAYS = 90 rồi bấm Run Manually để backfill. Lịch hằng đêm dùng 1 (reconcile 24h).\nconst DAYS = 1;\nconst end = new Date();\nconst start = new Date(end.getTime() - DAYS * 86400000);\nreturn [{ json: { filter_date_start: start.toISOString(), filter_date_end: end.toISOString() } }];"
      },
      "id": "b4a00000-0000-4000-8000-000000000003",
      "name": "Settings",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [220, 100]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "https://YOUR-PROJECT.supabase.co/rest/v1/workspaces",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpCustomAuth",
        "sendQuery": true,
        "queryParameters": { "parameters": [{ "name": "select", "value": "website_id" }] },
        "options": { "timeout": 15000 }
      },
      "id": "b4a00000-0000-4000-8000-000000000004",
      "name": "Get Workspaces",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [440, 100],
      "credentials": { "httpCustomAuth": { "id": "REPLACE_SUPABASE", "name": "Supabase Service Key" } }
    },
    {
      "parameters": {
        "method": "GET",
        "url": "=https://api.crisp.chat/v1/website/{{ $json.website_id }}/operators/list",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpBasicAuth",
        "sendHeaders": true,
        "headerParameters": { "parameters": [{ "name": "X-Crisp-Tier", "value": "plugin" }] },
        "options": { "timeout": 15000 }
      },
      "id": "b4a00000-0000-4000-8000-000000000005",
      "name": "Get Operators",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [660, 0],
      "credentials": { "httpBasicAuth": { "id": "REPLACE_CRISP", "name": "Crisp Plugin Token" } }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://YOUR-PROJECT.supabase.co/rest/v1/rpc/ingest_event",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpCustomAuth",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ p_event: { website_id: $('Get Workspaces').item.json.website_id, event: 'operators:list', data: { operators: $json.data || [] } } }) }}",
        "options": { "timeout": 15000 }
      },
      "id": "b4a00000-0000-4000-8000-000000000006",
      "name": "Ingest Operators",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [880, 0],
      "credentials": { "httpCustomAuth": { "id": "REPLACE_SUPABASE", "name": "Supabase Service Key" } }
    },
    {
      "parameters": {
        "method": "GET",
        "url": "=https://api.crisp.chat/v1/website/{{ $json.website_id }}/conversations/1",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpBasicAuth",
        "sendQuery": true,
        "queryParameters": {
          "parameters": [
            { "name": "per_page", "value": "50" },
            { "name": "filter_date_start", "value": "={{ $('Settings').first().json.filter_date_start }}" },
            { "name": "filter_date_end", "value": "={{ $('Settings').first().json.filter_date_end }}" }
          ]
        },
        "sendHeaders": true,
        "headerParameters": { "parameters": [{ "name": "X-Crisp-Tier", "value": "plugin" }] },
        "options": {
          "timeout": 30000,
          "pagination": {
            "pagination": {
              "paginationMode": "responseContainsNextURL",
              "nextURL": "={{ $request.url.replace(/conversations\\/(\\d+)/, (m, p) => 'conversations/' + (Number(p) + 1)) }}",
              "paginationCompleteWhen": "other",
              "completeExpression": "={{ !Array.isArray($response.body.data) || $response.body.data.length === 0 }}",
              "limitPagesFetched": true,
              "maxRequests": 400
            }
          }
        }
      },
      "id": "b4a00000-0000-4000-8000-000000000007",
      "name": "List Conversations",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [660, 200],
      "credentials": { "httpBasicAuth": { "id": "REPLACE_CRISP", "name": "Crisp Plugin Token" } }
    },
    {
      "parameters": {
        "jsCode": "const out = [];\n$input.all().forEach((item, i) => {\n  const fallback = $('Get Workspaces').itemMatching(i)?.json?.website_id;\n  const convs = Array.isArray(item.json.data) ? item.json.data : [];\n  for (const c of convs) {\n    const website_id = c.website_id || fallback;\n    if (!website_id || !c.session_id) continue;\n    out.push({ json: { website_id, session_id: c.session_id, meta: c.meta || {}, state: c.state || null } });\n  }\n});\nreturn out;"
      },
      "id": "b4a00000-0000-4000-8000-000000000008",
      "name": "Split Conversations",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [880, 200]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "=https://api.crisp.chat/v1/website/{{ $json.website_id }}/conversation/{{ $json.session_id }}/messages",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpBasicAuth",
        "sendHeaders": true,
        "headerParameters": { "parameters": [{ "name": "X-Crisp-Tier", "value": "plugin" }] },
        "options": { "timeout": 15000, "batching": { "batch": { "batchSize": 5, "batchInterval": 1000 } } }
      },
      "id": "b4a00000-0000-4000-8000-000000000009",
      "name": "Get Messages",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1100, 200],
      "credentials": { "httpBasicAuth": { "id": "REPLACE_CRISP", "name": "Crisp Plugin Token" } },
      "onError": "continueRegularOutput"
    },
    {
      "parameters": {
        "jsCode": "return $input.all().map((item, i) => {\n  const c = $('Split Conversations').itemMatching(i).json;\n  const msgs = Array.isArray(item.json.data) ? item.json.data : [];\n  const events = [{ website_id: c.website_id, event: 'session:meta', data: { session_id: c.session_id, email: c.meta.email || null, nickname: c.meta.nickname || null, segments: c.meta.segments || [], state: c.state } }];\n  for (const m of msgs) events.push({ website_id: c.website_id, event: 'message:import', data: { ...m, session_id: c.session_id } });\n  return { json: { p_events: events } };\n});"
      },
      "id": "b4a00000-0000-4000-8000-00000000000a",
      "name": "Build Events",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1320, 200]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://YOUR-PROJECT.supabase.co/rest/v1/rpc/ingest_events",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpCustomAuth",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ p_events: $json.p_events }) }}",
        "options": { "timeout": 30000, "batching": { "batch": { "batchSize": 5, "batchInterval": 200 } } }
      },
      "id": "b4a00000-0000-4000-8000-00000000000b",
      "name": "Ingest Events",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [1540, 200],
      "credentials": { "httpCustomAuth": { "id": "REPLACE_SUPABASE", "name": "Supabase Service Key" } },
      "onError": "continueRegularOutput"
    }
  ],
  "connections": {
    "Nightly": { "main": [[{ "node": "Settings", "type": "main", "index": 0 }]] },
    "Run Manually": { "main": [[{ "node": "Settings", "type": "main", "index": 0 }]] },
    "Settings": { "main": [[{ "node": "Get Workspaces", "type": "main", "index": 0 }]] },
    "Get Workspaces": { "main": [[
      { "node": "Get Operators", "type": "main", "index": 0 },
      { "node": "List Conversations", "type": "main", "index": 0 }
    ]] },
    "Get Operators": { "main": [[{ "node": "Ingest Operators", "type": "main", "index": 0 }]] },
    "List Conversations": { "main": [[{ "node": "Split Conversations", "type": "main", "index": 0 }]] },
    "Split Conversations": { "main": [[{ "node": "Get Messages", "type": "main", "index": 0 }]] },
    "Get Messages": { "main": [[{ "node": "Build Events", "type": "main", "index": 0 }]] },
    "Build Events": { "main": [[{ "node": "Ingest Events", "type": "main", "index": 0 }]] }
  },
  "active": false,
  "settings": { "executionOrder": "v1" }
}
```

Giới hạn đã biết: mỗi conversation chỉ lấy trang tin mới nhất của Crisp. Như vậy đủ cho reconcile 24h và đủ mẫu cho học tone. Conversation rất dài trong backfill 90 ngày sẽ thiếu phần tin cũ.

- [ ] **Step 7: Chạy test, xác nhận pass**

Run: `deno task test`
Expected: toàn bộ test Deno pass, gồm 4 test `validate.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add n8n/ deno.json
git commit -m "feat(n8n): ingest, refresh, post-note and sync gateway workflows"
```

---

### Task 9: Deploy và kiểm tra end-to-end

**Files:**
- Create: `supabase/seed/workspaces.example.sql`, `docs/setup.md`

**Interfaces:**
- Consumes: mọi thứ ở Task 1–8.
- Produces: hệ thống chạy thật trên 2 workspace. `check` gọi được bằng curl.

- [ ] **Step 1: Viết `supabase/seed/workspaces.example.sql`**

```sql
-- Chạy trong Supabase SQL Editor sau khi `db push`. Thay giá trị trong <>.
insert into public.workspaces (website_id, name, jira_project, helpdesk_locale, topics, default_profile)
values
  ('<WEBSITE_ID_APP_A>', '<App A>', '<JIRA_PROJECT_A>', 'en',
   '[{"key":"billing","label":"Billing","segments":["billing","payment"]},
     {"key":"bug","label":"Bug","segments":["bug"]},
     {"key":"setup","label":"Setup","segments":["setup","onboarding"]}]',
   '{"tone":"thân thiện, lịch sự, ngắn gọn","pronoun_self":"mình","pronoun_customer":"bạn"}'),
  ('<WEBSITE_ID_APP_B>', '<App B>', '<JIRA_PROJECT_B>', 'en',
   '[{"key":"billing","label":"Billing","segments":["billing"]}]',
   '{"tone":"thân thiện, lịch sự, ngắn gọn"}');
```

- [ ] **Step 2: Viết `docs/setup.md`** (checklist cho chính bạn, ghi các bước 3–8 dưới đây dưới dạng danh sách lệnh)

- [ ] **Step 3: Tạo project Supabase mới và đẩy schema**

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
```

Expected: 2 migration được áp. Chạy `workspaces.example.sql` (đã điền) trong SQL Editor.

- [ ] **Step 4: Secrets + deploy function**

```bash
openssl rand -hex 24   # -> N8N_SHARED_SECRET
npx supabase secrets set N8N_WEBHOOK_BASE=https://<n8n-domain>/webhook N8N_SHARED_SECRET=<secret>
npx supabase functions deploy copilot --no-verify-jwt
```

- [ ] **Step 5: Import 4 workflow vào n8n**

Với từng file trong `n8n/`: Import from File → chọn lại credential Supabase (Custom Auth) và Crisp (Basic Auth) → thay `YOUR-PROJECT`, `REPLACE_N8N_SHARED_SECRET`, đổi `crisp-ingest-REPLACE-WITH-RANDOM` thành chuỗi ngẫu nhiên → Activate.

- [ ] **Step 6: Đăng ký web hook Crisp cho cả 2 website**

URL = Production URL của `Crisp Webhook`. Events: `message:send`, `message:received`, `session:set_segments`, `session:set_state`, `session:set_email`.
Kiểm tra: gửi một tin thử trong Crisp, rồi chạy SQL `select * from messages order by id desc limit 5;` thấy tin đó.

- [ ] **Step 7: Backfill 90 ngày**

Trong `crisp-sync`: sửa `DAYS = 90` ở node Settings → Run Manually → mở execution, xác nhận node `List Conversations` gọi lần lượt `/conversations/1`, `/conversations/2`, … rồi dừng khi gặp trang rỗng. Xong thì trả `DAYS = 1` và lưu.

Kiểm tra:

```sql
select website_id, count(*) conversations from conversations group by 1;
select website_id, count(*) filter (where is_bot) bot_msgs, count(*) total from messages group by 1;
select website_id, bot_identifiers->'learned' from workspaces;
select o.display_name, w.website_id from operators o join operator_workspaces w using (crisp_user_id);
```

Expected: cả 2 website có dữ liệu, `learned` có `mary`/`zoey`, danh sách CS đúng.

- [ ] **Step 8: Cấp token cho CS và gọi `check` thật**

Trong SQL Editor (sau backfill, khi bảng `operators` đã có CS):

```sql
select crisp_user_id, display_name, email, public.issue_copilot_token(crisp_user_id) as token
from public.operators where email = '<email của bạn>';
```

Lưu token (chỉ hiện một lần). Sau này gửi riêng cho từng CS để dán vào Options của extension (Plan 5).

```bash
curl -s -X POST https://<PROJECT_REF>.supabase.co/functions/v1/copilot \
  -H 'content-type: application/json' -H 'x-copilot-token: <token vừa cấp>' \
  -d '{"website_id":"<WEBSITE_ID_APP_A>","session_id":"<session_ thật>","action":"check"}'
```

Expected: HTTP 200, `"stale":false` (refresh n8n chạy được), `unanswered` khớp với thực tế trong Crisp.

- [ ] **Step 9: Commit**

```bash
git add supabase/seed/workspaces.example.sql docs/setup.md
git commit -m "docs: deployment checklist and workspace seed template"
```
