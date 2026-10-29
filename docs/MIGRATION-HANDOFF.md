# Migration handoff — moving cs-copilot into the chatbot repo

Written 2026-10-29, at the point where this repo's contents are complete and
green (695/695 tests) and ready to be lifted into the chatbot repo as the
"Support Operation" module. Everything below is what a person (or agent)
doing the migration needs so nothing is lost and nothing collides.

## 1. What this codebase is, in one map

- `supabase/functions/copilot/` — the Edge Function the Crisp widget and the
  n8n internal jobs call. Actions are dispatched in `copilot/handler.ts`;
  `copilot/index.ts` is the entry (CORS, internal-action auth gate).
- `supabase/functions/_shared/` — the portable core: AI calls, sentiment,
  Storefront Watch client, Crisp/Jira clients, DB layer, trace framework.
  This layer must not gain Crisp- or Transcy-specific hardcoding; platform
  specifics belong in the shell/config (per the product direction set
  2026-10-26).
- `supabase/functions/mcp/`, `supabase/functions/embed-helpdesk/`,
  `supabase/functions/jira-sync/` — satellite functions.
- `supabase/migrations/` — full DB history, 001–032. Migration **032**
  (trace framework: `trace_log.flow_id`, `sentiment_history`) is the latest;
  it must be applied with `db:push` wherever the functions run.
- `widget/` — the Crisp sidebar panel (plain JS, no build step; Netlify
  serves this directory as-is). `widget/extension.zip` is intentional: the
  panel links it as the team download. Never delete it.
- `extension/` — the Chrome extension that bridges the widget to the Crisp
  composer (insert-only; there are no Copy buttons anywhere). Built by
  `scripts/build-extension.mjs` into `extension/dist/` + `widget/extension.zip`.
- `n8n/` — workflow templates. n8n is only a webhook gate/scheduler; all
  logic lives in the Edge Functions and DB.
- `scripts/` — operator scripts (helpdesk sync/embed, learn-profiles,
  db-push wrapper, extension build).

## 2. Hard rules that must survive the migration

- **Crisp write rule:** the copilot only prepares (1) private notes and
  (2) draft responses, staged into the Crisp composer via the extension for
  a human to send. It never posts or sends anything itself. Sole exceptions:
  the automated `storefront-watch` conversation segment (Transcy workspace
  only, merge never replace), Storefront Watch finding state changes made by
  a CS pressing a panel button, and the internal Storefront digest email to
  operators.
- **Jira is read-only and panel-only.** Sync only ever searches Jira and
  mirrors into our DB/panel. It creates nothing in Crisp.
  `workspaces.jira_auto_note` stays false (migration 018).
- **No auto-classify, no auto-routing/assignment.** Both were dropped by
  decision and must not be revived.
- **Learning is suggestion-only.** Per-CS templates stay original; the panel
  offers an optimized suggestion with a reason, the CS decides. Profiles are
  keyed by Crisp account (global); product knowledge is per-workspace.
- **Customer-facing copy:** no long dash "—" in drafts/templates written for
  customers; no decorative emoji in generated UI/note/template content.
- Panel copy shows only what a CS needs: status, facts, errors, actions.
  No internal-mechanism explanations in the UI.

## 3. Environment and secrets (names only — values live in Ethan's .env)

Supabase project ref: `rbodkthyuiyfotewgxku` ("Copilot CS OE").
Function URL shape: `https://<ref>.supabase.co/functions/v1/copilot`.

- `SUPABASE_SERVICE_ROLE_KEY` — DB access for functions and scripts.
- `N8N_SHARED_SECRET` — shared secret for internal actions (see auth note).
- `N8N_WEBHOOK_BASE` — base URL the functions use to call n8n back.
- `OPENAI_API_KEYS` — model calls (OpenAI `gpt-6-luna`,
  `text-embedding-3-small` at 768 dims). Gemini billing is OFF by decision;
  do not re-enable.
- `SW_API_TOKEN`, `SW_MCP_SIGNING_SECRET` — Storefront Watch MCP
  (`https://sw-api.transcy.io/mcp`, called directly, HMAC-SHA256 signing).
- `CRISP_PLUGIN_IDENTIFIER`, `CRISP_PLUGIN_KEY` — Crisp plugin/API access;
  operators-email scope is required for the digest mailer.
- Widget build: `WIDGET_ORIGIN=https://copilot-oe.netlify.app`.

If these names collide with variables already used by the chatbot repo,
prefix the copilot ones rather than renaming in code at migration time.

## 4. n8n workflows — inventory and the import lessons (verified live)

Workflows: Gateway (ingest + precompute), Crisp Sync, Refresh Conversation,
Helpdesk Sync, Jira Sync (must stay OFF — the Edge Function sync is the one
active source), Storefront Digest (daily 09:00, imported and manually
verified 2026-10-29).

Never re-import the Gateway JSON over the live workflow: it would reset
webhook paths, URLs, and credentials.

Two failure modes cost real debugging time on 2026-10-29; both are now baked
into `n8n/storefront-digest.json` in this repo:

1. **JSON Body with embedded `{{ }}` must be stored as an expression**
   (value starts with `=`). Stored as a fixed string, n8n validates it as
   literal JSON and fails at the `{{` position ("not valid JSON ...
   position 47").
2. **Internal-action auth checks one credential, `x-copilot-secret` first.**
   The copilot function accepts, in priority order: the `x-copilot-secret`
   header, else the `apikey`/Bearer from the node's Supabase API credential
   (service role). Working nodes (e.g. Gateway's `Ingest · Precompute
   Sentiment`) send **no** secret header and pass on the Supabase credential
   alone. A node that sends `x-copilot-secret` with a wrong or placeholder
   value gets 401 "Thiếu credential nội bộ" even when its Supabase
   credential is valid. When in doubt, delete the header row.

The editor's OUTPUT panel shows the last stored execution; it does not
re-evaluate after an edit. Judge a fix only by a fresh execution.

## 5. Trace framework (migration 032) — the contract the dashboard reads

Ethan is building his own dashboard; the panel has no trace UI. The
framework's job is that every operation writes complete rows:

- Every request to the copilot function gets one `flow_id`
  (`<action>-<base36 time>-<uuid prefix>`), shared by its timing and error
  rows in `trace_log` (columns: `flow_id`, `action`, `stage`, `duration_ms`,
  `error_code`, `detail`).
- Error codes are a closed set: `AUTH`, `DATA`, `AI`, `UPSTREAM`, `CLIENT`,
  `UNKNOWN` (`TRACE_ERROR_CODES` in `_shared/trace.ts`). `FlowTracer`
  records stages; tracing failures never break the business flow.
- `sentiment_history` is append-only: one row per fresh sentiment
  computation (never on cache hits), with score/mood/urgency/confidence,
  summary, signals, issues, model, and `source`
  (`analyze` | `precompute` | `generate`). The current value still lives in
  `conversation_sentiment`; history exists for trends and calibration.

## 6. Hosting state at handoff

- Functions deploy from master via `.github/workflows/deploy-functions.yml`
  (do not edit workflow files through the GitHub API — the app lacks the
  workflow permission; use the web UI).
- Netlify site `copilot-oe` (Site ID `25b53bcd-0d7b-435b-b342-4c115e7e9886`,
  https://copilot-oe.netlify.app) is Git-connected, but **auto build is
  STOPPED** (set 2026-10-29 ahead of the panel merge). Merging to master
  does not deploy the widget until builds are re-enabled in Netlify:
  Project configuration → Developer settings → Build settings → Active builds.
- Extension version is locked in two places that must move together:
  `extension/manifest.template.json` and `EXPECTED_EXTENSION_VERSION` in
  `widget/bridge-core.js` (currently 1.2.6). CI (`extension/zip.test.js`)
  fails if the committed `widget/extension.zip` does not match a fresh
  build, so upload a rebuilt zip in the same change whenever extension code
  changes. The zip is binary and cannot go through the GitHub API
  connector — upload it via the GitHub web UI.

## 7. Storefront digest semantics (so the numbers are read correctly)

Result fields per run: `checked` stores inspected, `seeded` stores recorded
as baseline for the first time (silent), `changed` stores whose sweep moved,
`reported` stores with NEW root-cause-grouped bugs, `emailed` true only when
an email actually went out, `failed` stores that could not be read
(never-checked or unreachable stores; noise only, does not block email).
Email title is exactly "Storefront Watch Weekly Scan"; one email per run;
baseline advances only after a successful send.

## 8. Known open items at handoff (not blockers for migration)

- First live Storefront panel write (Take case / Fix / Dismiss) not yet
  verified against real SW; whether acknowledged state appears in
  `list_findings` is unknown.
- Live verdicts still pending: Arabic sentiment rendered in Vietnamese;
  note fill with an old draft in the box; the Jira Sync n8n workflow's
  disabled state has not been eyeballed.
- CSAT exists in two unsynced sources (chatbot sheet + copilot DB survey).
- The merged "Support Operation" panel (hybrid native Crisp UI) is designed
  and briefed separately; this repo's widget remains the fallback until the
  merged panel ships.

## 9. Native face (Crisp Generic Widget) — added 2026-10-29

The copilot plugin now also carries a native Generic Widget face
("Support Operation") alongside the iframe panel, because Generic Widget
sections are deployed (expanded) by default when a conversation opens.
It is deliberately thin: data items display state, buttons open the
existing iframe widget in a modal deep-linked via `?open=<view>`, and one
hook (CSAT) sends server-side. All heavy UI stays in the iframe widget.

- Schema: `widget/native-panel.json` (3 sections: Khách / Trạng thái /
  Action; no Chatbot section in this phase). Setup steps, the exact action
  URL, and the color-enum mapping live in `docs/native-panel.md`.
- Server: `supabase/functions/copilot/native.ts`, routed inside the
  `copilot` function BEFORE both auth gates (widget events carry
  `X-Crisp-Signature`, not internal credentials). Data fetches are DB-only
  reads; the CSAT hook reuses `runSurvey` unchanged (same atomic claim +
  30s anti-double window). Every event writes `trace_log` rows
  (actions `native_fetch` / `native_hook`, flow ids `native-<item_id>-…`).
- Widget: `?open=` deep-link support in `widget/app.js` / `core.js`
  (`parseOpenParam`, `openModalName`); review maps to the existing `csat`
  modal, storefront/jira scroll to their inline cards.
- Unverified until first live use (see docs/native-panel.md): the exact
  HMAC composition Crisp uses for widget signatures and whether Crisp
  signs every widget event — the verifier therefore accepts unsigned
  events and trace-flags them, but rejects present-but-invalid
  signatures with 401.
