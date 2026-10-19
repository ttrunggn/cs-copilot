import { assertEquals } from "jsr:@std/assert@1";
import { handleJiraSync, type JiraStore } from "../jira-sync/handler.ts";
import type { JiraIssue, JiraLink } from "../_shared/jira.ts";

const SECRET = "s".repeat(40);
const adf = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const raw = (status: string, cat: string, comments: { id: string; who: string; text: string; at: string }[]) => ({
  key: "TNT-1",
  fields: {
    summary: "Bug",
    status: { name: status, statusCategory: { key: cat } },
    updated: "2026-10-19T03:00:00.000+0700",
    comment: { comments: comments.map((c) => ({ id: c.id, author: { displayName: c.who }, body: adf(c.text), created: c.at })) },
  },
});
const link = (over: Partial<JiraLink & { auto_note: boolean }> = {}) => ({
  website_id: "ws1", session_id: "session_1", issue_key: "TNT-1", url: "https://x.atlassian.net/browse/TNT-1",
  silent_baseline: false, last_seen_status: null, last_seen_comment_at: null, auto_note: true, ...over,
});

function fakes(links: ReturnType<typeof link>[], postOk = true) {
  const saved: JiraIssue[] = [];
  const updates: { session_id: string; patch: Record<string, unknown> }[] = [];
  const notes: string[] = [];
  const store: JiraStore = {
    csNames: () => Promise.resolve(["Anna Tran"]),
    saveIssue: (i) => (saved.push(i), Promise.resolve()),
    linksFor: () => Promise.resolve(links),
    updateLink: (l, patch) => (updates.push({ session_id: l.session_id, patch }), Promise.resolve()),
  };
  const n8n = {
    refreshConversation: () => Promise.resolve({ stale: false }),
    postNote: (_w: string, _s: string, c: string) => (notes.push(c), Promise.resolve(postOk)),
  };
  return { store, n8n, saved, updates, notes };
}

const C1 = { id: "1", who: "Dev Minh", text: "Investigating", at: "2026-10-19T01:00:00.000+0700" };
const C2 = { id: "2", who: "Dev Minh", text: "Fixed", at: "2026-10-19T02:00:00.000+0700" };

Deno.test("jira-sync rejects a wrong secret", async () => {
  const f = fakes([]);
  const r = await handleJiraSync("nope", { issues: [] }, { store: f.store, n8n: f.n8n, secret: SECRET });
  assertEquals(r.status, 401);
});

Deno.test("first sync of a pasted link posts the follow note and records the baseline", async () => {
  const f = fakes([link()]);
  const r = await handleJiraSync(SECRET, { issues: [raw("Pending Dev", "indeterminate", [C1])] }, { store: f.store, n8n: f.n8n, secret: SECRET });
  assertEquals(r.body, { issues: 1, notes: 1 });
  assertEquals(f.saved[0].issue_key, "TNT-1");
  assertEquals(f.notes[0].startsWith("🔗 Đã theo dõi Jira · TNT-1"), true);
  assertEquals(f.updates[0].patch.last_seen_status, "Pending Dev");
  assertEquals(typeof f.updates[0].patch.last_notified_at, "string");
});

Deno.test("silent baseline records state without posting", async () => {
  const f = fakes([link({ silent_baseline: true })]);
  await handleJiraSync(SECRET, { issues: [raw("Pending Dev", "indeterminate", [C1])] }, { store: f.store, n8n: f.n8n, secret: SECRET });
  assertEquals(f.notes, []);
  assertEquals(f.updates[0].patch.last_seen_status, "Pending Dev");
});

Deno.test("new tech comment posts an update; nothing new posts nothing", async () => {
  const seen = { last_seen_status: "Pending Dev", last_seen_comment_at: "2026-10-18T18:00:00.000Z" };
  const f = fakes([link(seen)]);
  await handleJiraSync(SECRET, { issues: [raw("Pending Dev", "indeterminate", [C1, C2])] }, { store: f.store, n8n: f.n8n, secret: SECRET });
  assertEquals(f.notes.length, 1);
  assertEquals(f.notes[0].includes("• [Tech] Dev Minh"), true);
  const g = fakes([link({ last_seen_status: "Pending Dev", last_seen_comment_at: "2026-10-18T19:00:00.000Z" })]);
  await handleJiraSync(SECRET, { issues: [raw("Pending Dev", "indeterminate", [C1, C2])] }, { store: g.store, n8n: g.n8n, secret: SECRET });
  assertEquals(g.notes, []);
});

Deno.test("done ticket posts a final note and stops tracking", async () => {
  const f = fakes([link({ last_seen_status: "Pending Dev", last_seen_comment_at: "2026-10-18T19:00:00.000Z" })]);
  await handleJiraSync(SECRET, { issues: [raw("Done", "done", [C1, C2])] }, { store: f.store, n8n: f.n8n, secret: SECRET });
  assertEquals(f.notes[0].includes("Ticket đã xong, ngừng theo dõi."), true);
  assertEquals(f.updates[0].patch.active, false);
});

Deno.test("failed note post keeps the old baseline so the update is retried", async () => {
  const f = fakes([link({ last_seen_status: "To Do", last_seen_comment_at: "2026-10-18T18:00:00.000Z" })], false);
  const r = await handleJiraSync(SECRET, { issues: [raw("Pending Dev", "indeterminate", [C1])] }, { store: f.store, n8n: f.n8n, secret: SECRET });
  assertEquals(r.body, { issues: 1, notes: 0 });
  assertEquals(f.updates, []);
});

Deno.test("workspace with auto-note off advances the baseline silently", async () => {
  const f = fakes([link({ auto_note: false, last_seen_status: "To Do", last_seen_comment_at: "2026-10-18T18:00:00.000Z" })]);
  await handleJiraSync(SECRET, { issues: [raw("Pending Dev", "indeterminate", [C1])] }, { store: f.store, n8n: f.n8n, secret: SECRET });
  assertEquals(f.notes, []);
  assertEquals(f.updates[0].patch.last_seen_status, "Pending Dev");
});

Deno.test("malformed issues in the payload are skipped", async () => {
  const f = fakes([]);
  const r = await handleJiraSync(SECRET, { issues: [null, { nokey: 1 }, "x"] }, { store: f.store, n8n: f.n8n, secret: SECRET });
  assertEquals(r.body, { issues: 0, notes: 0 });
});
