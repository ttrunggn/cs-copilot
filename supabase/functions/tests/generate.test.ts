import { assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { AiUnavailable } from "../_shared/gemini.ts";
import type { HelpdeskChunk, OutputRow } from "../_shared/types.ts";
import { CONV, fakeAi, makeDeps, msg, TOKEN } from "./fakes.ts";

const REQ = { website_id: "ws1", session_id: "session_1", action: "generate" };
const HD: HelpdeskChunk = { title: "Currency", url: "https://help.transcy.io/en/article/currency", text: "Enable auto currency.", similarity: 0.8 };
const WARN = JSON.stringify({ warnings: [{ claim: "Currency is automatic.", reason: "Bài viết nói phải bật", article_url: HD.url }] });

function setup(o: { helpdesk?: HelpdeskChunk[]; ai?: ReturnType<typeof fakeAi>; cached?: OutputRow | null; topic?: string | null } = {}) {
  const f = o.ai ?? fakeAi({ draft: "Currency is automatic.", verify: WARN });
  const topics: [string, string, string][] = [];
  const m = makeDeps({
    ai: f.ai,
    cached: o.cached,
    db: {
      getConversation: () => Promise.resolve({ ...CONV, topic: o.topic === undefined ? CONV.topic : o.topic }),
      matchHelpdesk: () => Promise.resolve(o.helpdesk ?? [HD]),
      setAiTopic: (w, s, t) => (topics.push([w, s, t]), Promise.resolve()),
    },
  });
  return { ...m, calls: f.calls, topics };
}

Deno.test("generate returns draft, warnings and stores output", async () => {
  const { deps, inserted } = setup();
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(r.body, {
    action: "generate",
    stale: false,
    cached: false,
    output_id: 42,
    draft: "Currency is automatic.",
    warnings: [{ claim: "Currency is automatic.", reason: "Bài viết nói phải bật", article_url: HD.url }],
    verified: true,
    helpdesk_matches: 1,
    topic: "billing",
    topic_label: "Thanh toán & gói",
    profile_source: "default",
    prompt_version: "draft-v1",
  });
  assertEquals(inserted[0].kind, "draft");
  assertEquals(inserted[0].prompt_version, "draft-v1");
  assertEquals(inserted[0].helpdesk_matches, 1);
  assertEquals(inserted[0].profile_used, "default");
  assertEquals(inserted[0].input_fp.length, 64);
});

Deno.test("draft prompt carries the agent's last messages so the reply continues their flow", async () => {
  const { deps, calls } = setup();
  await handle(REQ, TOKEN, deps);
  const p = calls.find((c) => c.task === "draft")!.prompt;
  assertEquals(p.includes("Agent (Lan): b"), true);
  assertEquals(p.includes("Do not greet again"), true);
});

Deno.test("draft prompt keeps the bot's customer-facing answer for a human takeover", async () => {
  const { deps, calls } = setup();
  deps.db.getMessages = () => Promise.resolve([
    msg("user", "Do you keep backups?", 1),
    msg("operator", "Successful translations are saved in Translation History.", 2, { is_bot: true, operator_name: "Mary" }),
  ]);
  await handle(REQ, TOKEN, deps);
  const p = calls.find((c) => c.task === "draft")!.prompt;
  assertEquals(p.includes("Bot (Mary): Successful translations are saved in Translation History."), true);
});

Deno.test("generate uses content_en in prompt", async () => {
  const f = fakeAi({
    translate: JSON.stringify({ items: [{ i: 0, en: "My currency does not change" }] }),
    draft: "ok",
    verify: '{"warnings":[]}',
  });
  const m = makeDeps({ ai: f.ai, messages: [msg("user", "Ma devise ne change pas du tout", 1)], db: { matchHelpdesk: () => Promise.resolve([HD]) } });
  await handle(REQ, TOKEN, m.deps);
  const draft = f.calls.find((c) => c.task === "draft")!.prompt;
  assertEquals(draft.includes("My currency does not change"), true);
  assertEquals(draft.includes("Ma devise"), false);
  assertEquals(f.calls.find((c) => c.task === "embed")!.prompt, "My currency does not change");
});

Deno.test("generate classifies missing topic and saves it", async () => {
  const f = fakeAi({ classify: '{"topic":"translation"}', draft: "ok", verify: '{"warnings":[]}' });
  const { deps, topics } = setup({ ai: f, topic: null });
  const body = (await handle(REQ, TOKEN, deps)).body as { topic: string };
  assertEquals(body.topic, "translation");
  assertEquals(topics, [["ws1", "session_1", "translation"]]);
});

Deno.test("generate continues without topic when classify fails", async () => {
  const f = fakeAi({ classify: new AiUnavailable(), draft: "ok", verify: '{"warnings":[]}' });
  const { deps, topics } = setup({ ai: f, topic: null });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals((r.body as { topic: string | null }).topic, null);
  assertEquals(topics, []);
});

Deno.test("generate skips verify when no helpdesk chunk passes threshold", async () => {
  const { deps, calls } = setup({ helpdesk: [{ ...HD, similarity: 0.3 }] });
  const body = (await handle(REQ, TOKEN, deps)).body as Record<string, unknown>;
  assertEquals(calls.some((c) => c.task === "verify"), false);
  assertEquals(calls.find((c) => c.task === "draft")!.prompt.includes("[H1]"), false);
  assertEquals([body.helpdesk_matches, body.verified, body.warnings], [0, true, []]);
});

Deno.test("verify parse failure returns draft unverified", async () => {
  const { deps } = setup({ ai: fakeAi({ draft: "Hello", verify: "nope" }) });
  const body = (await handle(REQ, TOKEN, deps)).body as Record<string, unknown>;
  assertEquals([body.draft, body.verified, body.warnings], ["Hello", false, []]);
});

Deno.test("second generate with same input returns cached output", async () => {
  const cached: OutputRow = {
    id: 9, kind: "draft", content: "cached draft", warnings: [], verified: true, helpdesk_matches: 2,
    topic: "billing", prompt_version: "draft-v1", posted: null, created_at: "2026-10-15T03:05:00+00:00",
  };
  const { deps, calls } = setup({ cached });
  const body = (await handle(REQ, TOKEN, deps)).body as Record<string, unknown>;
  assertEquals([body.cached, body.output_id, body.draft, body.helpdesk_matches], [true, 9, "cached draft", 2]);
  assertEquals(calls.filter((c) => c.task === "draft").length, 0);
});

Deno.test("force bypasses cache", async () => {
  const cached: OutputRow = {
    id: 9, kind: "draft", content: "cached", warnings: [], verified: true, helpdesk_matches: 0,
    topic: null, prompt_version: "draft-v1", posted: null, created_at: "2026-10-15T03:05:00+00:00",
  };
  const { deps } = setup({ cached });
  const body = (await handle({ ...REQ, force: true }, TOKEN, deps)).body as Record<string, unknown>;
  assertEquals(body.cached, false);
});

Deno.test("AI unavailable on draft returns 503 AI_UNAVAILABLE", async () => {
  const { deps, inserted } = setup({ ai: fakeAi({ draft: new AiUnavailable() }) });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 503);
  assertEquals((r.body as { code: string }).code, "AI_UNAVAILABLE");
  assertEquals(inserted, []);
});

Deno.test("generate still works when embed fails", async () => {
  const f = fakeAi({ draft: "ok" }, new Error("embed down"));
  const { deps } = setup({ ai: f });
  const body = (await handle(REQ, TOKEN, deps)).body as Record<string, unknown>;
  assertEquals([body.draft, body.helpdesk_matches, body.verified], ["ok", 0, false]);
});

Deno.test("check returns latest_draft", async () => {
  const latest: OutputRow = {
    id: 5, kind: "draft", content: "last draft", warnings: [], verified: false, helpdesk_matches: 0,
    topic: null, prompt_version: "draft-v1", posted: null, created_at: "2026-10-15T03:06:00+00:00",
  };
  const m = makeDeps({ db: { getLatestDraft: () => Promise.resolve(latest) } });
  const body = (await handle({ ...REQ, action: "check" }, TOKEN, m.deps)).body as { latest_draft: unknown };
  assertEquals(body.latest_draft, { output_id: 5, content: "last draft", warnings: [], verified: false, helpdesk_matches: 0, created_at: latest.created_at });
});

Deno.test("off-topic helpdesk chunks around 0.52–0.6 similarity are not used", async () => {
  const { deps, calls } = setup({ helpdesk: [{ ...HD, similarity: 0.6 }] });
  const body = (await handle(REQ, TOKEN, deps)).body as Record<string, unknown>;
  assertEquals(body.helpdesk_matches, 0);
  assertEquals(calls.some((c) => c.task === "verify"), false);
});

Deno.test("empty AI draft is not saved or cached and returns AI_BAD_OUTPUT", async () => {
  const { deps, inserted } = setup({ ai: fakeAi({ draft: "   " }) });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 503);
  assertEquals(r.body, { error: "AI trả kết quả không dùng được, bấm lại thử", code: "AI_BAD_OUTPUT" });
  assertEquals(inserted, []);
});

Deno.test("check hides a latest draft written before the newest customer message", async () => {
  const old: OutputRow = {
    id: 5, kind: "draft", content: "old turn", warnings: [], verified: true, helpdesk_matches: 1,
    topic: null, prompt_version: "draft-v1", posted: null, created_at: "2026-10-15T03:02:30+00:00", // trước last_customer_at 03:03
  };
  const m = makeDeps({ db: { getLatestDraft: () => Promise.resolve(old) } });
  const body = (await handle({ ...REQ, action: "check" }, TOKEN, m.deps)).body as { latest_draft: unknown };
  assertEquals(body.latest_draft, null);
});

const JIRA_ROWS = [{
  link: {
    website_id: "ws1", session_id: "session_1", issue_key: "TNT-9184", url: "https://firegroup.atlassian.net/browse/TNT-9184",
    silent_baseline: false, last_seen_status: "Pending Dev", last_seen_comment_at: null,
  },
  issue: {
    issue_key: "TNT-9184", summary: "Switcher missing", status: "Pending Dev", status_category: "indeterminate", assignee: null,
    updated_at: null, status_changed_at: null,
    comments: [{ id: "2", author: "Dev Minh", role: "tech" as const, body_text: "Fixed, deploying tomorrow", created_at: "2026-10-15T03:10:00.000Z" }],
  },
}];

Deno.test("check lists linked Jira tickets with a NEW flag for tech news after the last agent reply", async () => {
  const m = makeDeps({ db: { getJiraRows: () => Promise.resolve(JIRA_ROWS) } });
  const body = (await handle({ ...REQ, action: "check" }, TOKEN, m.deps)).body as { jira: { issue_key: string; is_new: boolean }[] };
  assertEquals(body.jira.map((j) => [j.issue_key, j.is_new]), [["TNT-9184", true]]);
});

Deno.test("draft prompt carries Jira context so the reply can relay tech updates", async () => {
  const f = fakeAi({ draft: "ok", verify: '{"warnings":[]}' });
  const m = makeDeps({ ai: f.ai, db: { getJiraRows: () => Promise.resolve(JIRA_ROWS), matchHelpdesk: () => Promise.resolve([HD]) } });
  await handle(REQ, TOKEN, m.deps);
  const p = f.calls.find((c) => c.task === "draft")!.prompt;
  assertEquals(p.includes("TNT-9184 (Pending Dev): Switcher missing"), true);
  assertEquals(p.includes("[tech] Dev Minh: Fixed, deploying tomorrow"), true);
  assertEquals(p.includes("never paste ticket links"), true);
});
