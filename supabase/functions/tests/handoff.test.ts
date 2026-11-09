import { assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { AiUnavailable, REWRITE_TEMPERATURE } from "../_shared/gemini.ts";
import type { ProfileRow } from "../_shared/types.ts";
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

Deno.test("handoff returns the formatted Vietnamese note and stores the output — posting NOTHING to Crisp", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps, inserted } = makeDeps({ ai });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  const body = r.body as Record<string, unknown>;
  assertEquals(body.action, "handoff");
  assertEquals(body.cached, false);
  assertEquals(body.output_id, 42);
  assertEquals("posted" in body, false); // quy tắc ghi Crisp: handler chỉ trả text, không có khái niệm đã đăng
  assertEquals((body.note as string).startsWith("Handoff — Jamie Lee\nKhách cần sửa switcher"), true);
  assertEquals(inserted[0].kind, "handoff");
  assertEquals(inserted[0].content, body.note);
  assertEquals(inserted[0].operator_id, "op-jamie");
  assertEquals(inserted[0].posted, null);
});

Deno.test("handoff note lists each issue from a multi-issue message", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps } = makeDeps({ ai, messages: [msg("user", "1) switcher broken 2) change plan 3) translate theme", 1)] });
  const note = ((await handle(REQ, TOKEN, deps)).body as { note: string }).note;
  for (const line of ["1. Switcher không hiện trên mobile — Chờ tech", "2. Đổi sang gói annual — Xong", "3. Dịch theme mới — Chưa xử lý"]) {
    assertEquals(note.includes(line), true, line);
  }
});

Deno.test("handoff transcript keeps customer-facing bot replies but drops bot notes", async () => {
  const { ai, calls } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps } = makeDeps({
    ai,
    messages: [
      msg("user", "help", 1),
      msg("operator", "I am Mary the bot", 2, { is_bot: true, operator_name: "Mary" }),
      msg("operator", "old private note", 3, { is_bot: true, type: "note", operator_name: "Mary" }),
    ],
  });
  await handle(REQ, TOKEN, deps);
  const prompt = calls.find((c) => c.task === "handoff")!.prompt;
  assertEquals(prompt.includes("help"), true);
  assertEquals(prompt.includes("Bot (Mary): I am Mary the bot"), true);
  assertEquals(prompt.includes("old private note"), false);
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
  id: 7, kind: "handoff" as const, content: "Handoff — cũ", warnings: [], verified: null, helpdesk_matches: null,
  topic: "billing", prompt_version: null, posted: true, created_at: "2026-10-15T03:05:00+00:00",
};

Deno.test("cached handoff is returned as-is — no repost concept anymore, whatever the legacy posted flag says", async () => {
  const { deps } = makeDeps({ cached: { ...CACHED, posted: false } });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.body, { action: "handoff", stale: false, cached: true, output_id: 7, note: "Handoff — cũ" });
});

Deno.test("handoff CANNOT post to Crisp: the deps interfaces have no postNote/markPosted at all", async () => {
  // CRISP WRITE RULE giữ ở tầng CẤU TRÚC, không dựa vào "không ai gọi":
  // interface N8n/Db đã xoá hẳn postNote/markPosted (kèm workflow
  // copilot-post-note) — handoff muốn đăng cũng không có đường nào để gọi.
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps } = makeDeps({ ai });
  assertEquals("postNote" in deps.n8n, false);
  assertEquals("markPosted" in deps.db, false);
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(typeof (r.body as { note: string }).note, "string");
});

Deno.test("handoff cached skips AI and returns the stored note", async () => {
  const { ai, calls } = fakeAi({});
  const { deps } = makeDeps({ ai, cached: CACHED });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(r.body, { action: "handoff", stale: false, cached: true, output_id: 7, note: "Handoff — cũ" });
  assertEquals(calls.filter((c) => c.task === "handoff").length, 0);
});

Deno.test("handoff force ignores cache and regenerates — still posting nothing", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps, inserted } = makeDeps({ ai, cached: { ...CACHED, content: "old" } });
  const r = await handle({ ...REQ, force: true }, TOKEN, deps);
  assertEquals((r.body as { cached: boolean }).cached, false);
  assertEquals(inserted.length, 1);
});

Deno.test("handoff force passes the previous note and rewrite temperature; first generation passes neither", async () => {
  const { ai, calls } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps } = makeDeps({ ai, cached: { ...CACHED, content: "Bản note cũ duy nhất" } });
  await handle({ ...REQ, force: true }, TOKEN, deps);
  const forced = calls.find((c) => c.task === "handoff")!;
  assertEquals(forced.prompt.includes("Bản note cũ duy nhất"), true);
  assertEquals(forced.opts?.temperature, REWRITE_TEMPERATURE);

  const fresh = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps: deps2 } = makeDeps({ ai: fresh.ai });
  await handle(REQ, TOKEN, deps2);
  const first = fresh.calls.find((c) => c.task === "handoff")!;
  assertEquals(first.opts?.temperature, undefined);
});

Deno.test("handoff with unparseable AI output posts nothing", async () => {
  const { ai } = fakeAi({ handoff: "Sorry, I cannot help with that." });
  const { deps, inserted } = makeDeps({ ai });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 503);
  assertEquals((r.body as { code: string }).code, "AI_BAD_OUTPUT");
  assertEquals(inserted, []);
});

Deno.test("handoff AI unavailable returns 503", async () => {
  const { ai } = fakeAi({ handoff: new AiUnavailable() });
  const { deps } = makeDeps({ ai });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 503);
  assertEquals(r.body, { error: "AI đang hết quota hoặc lỗi, thử lại sau", code: "AI_UNAVAILABLE" });
});

Deno.test("unreadable handoff says AI_BAD_OUTPUT, not quota", async () => {
  const { ai } = fakeAi({ handoff: "not json" });
  const { deps } = makeDeps({ ai });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.body, { error: "AI trả kết quả không dùng được, bấm lại thử", code: "AI_BAD_OUTPUT" });
});

const NOTE_FMT_ROW: ProfileRow = {
  crisp_user_id: "op-jamie",
  website_id: "ws1",
  topic: "_all",
  conversations_used: 12,
  learned_at: "2026-10-14T00:00:00Z",
  manual_override: null,
  note_format: {
    language: "en",
    header: "Handoff — {name}",
    sections: [
      { field: "issues", label: "Issues raised:" },
      { field: "summary", label: "Why:" },
      { field: "next_step", label: "Next:" },
    ],
    line_style: "bullets",
    state_style: "text",
    sign_off: "— {name}",
    notes_used: 6,
  },
};

Deno.test("handoff renders in the CS's learned note format and records profile_used", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps, inserted } = makeDeps({ ai, db: { getProfiles: () => Promise.resolve([NOTE_FMT_ROW]) } });
  const r = await handle(REQ, TOKEN, deps);
  const body = r.body as { note: string };
  assertEquals(body.note, [
    "Handoff — Jamie Lee",
    "Issues raised:",
    "- Switcher không hiện trên mobile — Chờ tech: đã gửi ticket",
    "- Đổi sang gói annual — Xong: đã đổi",
    "- Dịch theme mới — Chưa xử lý: chưa trả lời",
    "Why: Khách cần sửa switcher và đổi gói",
    "Next: (waiting on tech) Báo khách khi tech fix",
    "— Jamie Lee",
  ].join("\n"));
  assertEquals(inserted[0].profile_used, "all");
  assertEquals(inserted[0].content, body.note);
});

Deno.test("handoff without a learned note format keeps the fixed template and records profile_used default", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const { deps, inserted } = makeDeps({ ai });
  await handle(REQ, TOKEN, deps);
  assertEquals(inserted[0].profile_used, "default");
  assertEquals((inserted[0].content as string).startsWith("Handoff — Jamie Lee\n"), true);
});

Deno.test("handoff ignores a note format learned from too few notes", async () => {
  const { ai } = fakeAi({ handoff: JSON.stringify(FIELDS) });
  const thin: ProfileRow = { ...NOTE_FMT_ROW, note_format: { ...NOTE_FMT_ROW.note_format!, notes_used: 2 } };
  const { deps, inserted } = makeDeps({ ai, db: { getProfiles: () => Promise.resolve([thin]) } });
  await handle(REQ, TOKEN, deps);
  assertEquals(inserted[0].profile_used, "default");
  assertEquals((inserted[0].content as string).startsWith("Handoff — Jamie Lee\n"), true);
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
