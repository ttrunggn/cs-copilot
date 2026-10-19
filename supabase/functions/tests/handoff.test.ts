import { assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { AiUnavailable } from "../_shared/gemini.ts";
import { fakeAi, makeDeps, msg, TOKEN } from "./fakes.ts";

const REQ = { website_id: "ws1", session_id: "session_1", action: "handoff" };
const FIELDS = {
  summary: "Khách cần sửa switcher và đổi gói",
  issues: [
    { issue: "Switcher không hiện trên mobile", state: "waiting_tech", detail: "đã gửi ticket" },
    { issue: "Đổi sang gói annual", state: "done", detail: "đã đổi" },
    { issue: "Dịch theme mới", state: "not_started", detail: "chưa trả lời" },
  ],
  done: "Kiểm tra theme",
  waiting_on: "tech",
  next_step: "Báo khách khi tech fix",
};

Deno.test("handoff posts formatted Vietnamese note and stores output", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps, inserted, notes } = makeDeps({ ai });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  const body = r.body as Record<string, unknown>;
  assertEquals(body.action, "handoff");
  assertEquals(body.posted, true);
  assertEquals(body.cached, false);
  assertEquals(body.output_id, 42);
  assertEquals((body.note as string).startsWith("📋 Handoff — Lan Nguyen\nKhách cần sửa switcher"), true);
  assertEquals(notes, [body.note]);
  assertEquals(inserted[0].kind, "handoff");
  assertEquals(inserted[0].content, body.note);
  assertEquals(inserted[0].operator_id, "op-lan");
});

Deno.test("handoff note lists each issue from a multi-issue message", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps } = makeDeps({ ai, messages: [msg("user", "1) switcher broken 2) change plan 3) translate theme", 1)] });
  const note = ((await handle(REQ, TOKEN, deps)).body as { note: string }).note;
  for (const line of ["1. Switcher không hiện trên mobile — 🛠 Chờ tech", "2. Đổi sang gói annual — ✅ Xong", "3. Dịch theme mới — ❗ Chưa xử lý"]) {
    assertEquals(note.includes(line), true, line);
  }
});

Deno.test("handoff transcript excludes bot messages", async () => {
  const { ai, calls } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps } = makeDeps({
    ai,
    messages: [msg("user", "help", 1), msg("operator", "I am Mary the bot", 2, { is_bot: true, operator_name: "Mary" })],
  });
  await handle(REQ, TOKEN, deps);
  const prompt = calls.find((c) => c.task === "handoff")!.prompt;
  assertEquals(prompt.includes("help"), true);
  assertEquals(prompt.includes("Mary the bot"), false);
});

Deno.test("handoff uses content_en in prompt", async () => {
  const { ai, calls } = fakeAi({
    translate: JSON.stringify({ items: [{ i: 0, en: "I want a refund for my plan" }] }),
    handoff: JSON.stringify(FIELDS),
  });
  const { deps } = makeDeps({ ai, messages: [msg("user", "Je veux un remboursement pour mon abonnement", 1)] });
  await handle(REQ, TOKEN, deps);
  const prompt = calls.find((c) => c.task === "handoff")!.prompt;
  assertEquals(prompt.includes("I want a refund for my plan"), true);
  assertEquals(prompt.includes("remboursement"), false);
});

const CACHED = {
  id: 7, kind: "handoff" as const, content: "📋 Handoff — cũ", warnings: [], verified: null, helpdesk_matches: null,
  topic: "billing", prompt_version: null, posted: true, created_at: "2026-10-15T03:05:00+00:00",
};

Deno.test("cached handoff that never reached Crisp is posted again", async () => {
  const marks: [number, boolean][] = [];
  const { deps, notes } = makeDeps({ cached: { ...CACHED, posted: false }, db: { markPosted: (id, p) => (marks.push([id, p]), Promise.resolve()) } });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.body, { action: "handoff", stale: false, cached: true, output_id: 7, note: "📋 Handoff — cũ", posted: true });
  assertEquals(notes, ["📋 Handoff — cũ"]);
  assertEquals(marks, [[7, true]]);
});

Deno.test("handoff records whether the note was posted", async () => {
  const marks: [number, boolean][] = [];
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps } = makeDeps({ ai, postOk: false, db: { markPosted: (id, p) => (marks.push([id, p]), Promise.resolve()) } });
  await handle(REQ, TOKEN, deps);
  assertEquals(marks, [[42, false]]);
});

Deno.test("handoff cached does not repost", async () => {
  const { ai, calls } = fakeAi({});
  const { deps, notes } = makeDeps({ ai, cached: CACHED });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(r.body, { action: "handoff", stale: false, cached: true, output_id: 7, note: "📋 Handoff — cũ", posted: true });
  assertEquals(notes, []);
  assertEquals(calls.filter((c) => c.task === "handoff").length, 0);
});

Deno.test("handoff force ignores cache", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps, notes } = makeDeps({ ai, cached: { ...CACHED, content: "old" } });
  const r = await handle({ ...REQ, force: true }, TOKEN, deps);
  assertEquals((r.body as { cached: boolean }).cached, false);
  assertEquals(notes.length, 1);
});

Deno.test("handoff post failure returns posted false with note", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps, inserted } = makeDeps({ ai, postOk: false });
  const body = (await handle(REQ, TOKEN, deps)).body as { posted: boolean; note: string };
  assertEquals(body.posted, false);
  assertEquals(body.note.startsWith("📋 Handoff"), true);
  assertEquals(inserted.length, 1);
});

Deno.test("handoff with unparseable AI output posts nothing", async () => {
  const { ai } = fakeAi({ handoff: "Sorry, I cannot help with that." });
  const { deps, notes, inserted } = makeDeps({ ai });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 503);
  assertEquals((r.body as { code: string }).code, "AI_BAD_OUTPUT");
  assertEquals(notes, []);
  assertEquals(inserted, []);
});

Deno.test("handoff AI unavailable returns 503", async () => {
  const { ai } = fakeAi({ handoff: new AiUnavailable() });
  const { deps, notes } = makeDeps({ ai });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 503);
  assertEquals(r.body, { error: "AI đang hết quota hoặc lỗi, thử lại sau", code: "AI_UNAVAILABLE" });
  assertEquals(notes, []);
});

Deno.test("unreadable handoff says AI_BAD_OUTPUT, not quota", async () => {
  const { ai } = fakeAi({ handoff: "not json" });
  const { deps } = makeDeps({ ai });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.body, { error: "AI trả kết quả không dùng được, bấm lại thử", code: "AI_BAD_OUTPUT" });
});

Deno.test("handoff prompt includes the linked Jira tickets", async () => {
  const { ai, calls } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const rows = [{
    link: { website_id: "ws1", session_id: "session_1", issue_key: "TNT-1", url: "u", silent_baseline: false, last_seen_status: null, last_seen_comment_at: null },
    issue: { issue_key: "TNT-1", summary: "Menu bug", status: "In Progress", status_category: "indeterminate", assignee: null, updated_at: null, comments: [] },
  }];
  const { deps } = makeDeps({ ai, db: { getJiraRows: () => Promise.resolve(rows) } });
  await handle(REQ, TOKEN, deps);
  assertEquals(calls.find((c) => c.task === "handoff")!.prompt.includes("<jira>\nTNT-1 (In Progress): Menu bug\n</jira>"), true);
});
