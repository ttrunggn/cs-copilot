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
const link = (over: Partial<JiraLink> = {}): JiraLink => ({
  website_id: "ws1", session_id: "session_1", issue_key: "TNT-1", url: "https://x.atlassian.net/browse/TNT-1",
  silent_baseline: false, last_seen_status: null, last_seen_comment_at: null, ...over,
});

// Jira là panel-only mirror: deps của handler CỐ Ý không có n8n — không tồn tại
// đường nào từ sync tới Crisp để mà gọi nhầm. Các test dưới đây khóa hành vi:
// sync chỉ saveIssue + updateLink (mốc đã thấy; tắt link CHỈ khi ticket Done
// và CS đã nhắn cho khách sau mốc Done — Done một mình không tắt link).
// `stored` giả lập hai mốc saveIssue thật ghi vào DB (mốc đổi trạng thái +
// trạng thái trước đó); `lastHumanAt` là mốc CS nhắn khách gần nhất của chat.
function fakes(links: JiraLink[], opts: { stored?: { status_changed_at: string | null; prev_status: string | null }; lastHumanAt?: string | null } = {}) {
  const saved: JiraIssue[] = [];
  const updates: { session_id: string; patch: Record<string, unknown> }[] = [];
  const store: JiraStore = {
    csNames: () => Promise.resolve(["Anna Tran"]),
    saveIssue: (i) => (saved.push(i), Promise.resolve(opts.stored ?? { status_changed_at: null, prev_status: null })),
    linksFor: () => Promise.resolve(links),
    updateLink: (l, patch) => (updates.push({ session_id: l.session_id, patch }), Promise.resolve()),
    lastHumanOperatorAt: () => Promise.resolve(opts.lastHumanAt ?? null),
  };
  return { store, saved, updates };
}

const C1 = { id: "1", who: "Dev Minh", text: "Investigating", at: "2026-10-19T01:00:00.000+0700" };
const C2 = { id: "2", who: "Dev Minh", text: "Fixed", at: "2026-10-19T02:00:00.000+0700" };

Deno.test("jira-sync rejects a wrong secret", async () => {
  const f = fakes([]);
  const r = await handleJiraSync("nope", { issues: [] }, { store: f.store, secret: SECRET });
  assertEquals(r.status, 401);
  assertEquals(f.saved, []);
  assertEquals(f.updates, []);
});

Deno.test("first sync saves the issue and records the baseline — creating nothing in Crisp", async () => {
  const f = fakes([link()]);
  const r = await handleJiraSync(SECRET, { issues: [raw("Pending Dev", "indeterminate", [C1])] }, { store: f.store, secret: SECRET });
  assertEquals(r.body, { issues: 1 });
  assertEquals(f.saved[0].issue_key, "TNT-1");
  assertEquals(f.saved[0].comments.length, 1);
  // Chỉ ghi mốc đã thấy vào DB của mình; không có last_notified_at (không còn khái niệm "đã báo vào chat").
  assertEquals(f.updates.length, 1);
  assertEquals(f.updates[0].patch.last_seen_status, "Pending Dev");
  assertEquals(f.updates[0].patch.last_seen_comment_at, "2026-10-18T18:00:00.000Z"); // C1: 01:00+0700 → 18:00Z hôm trước
  assertEquals("last_notified_at" in f.updates[0].patch, false);
  assertEquals(f.updates[0].patch.active, undefined);
});

Deno.test("silent baseline records state the same way (no special Crisp behavior)", async () => {
  const f = fakes([link({ silent_baseline: true })]);
  await handleJiraSync(SECRET, { issues: [raw("Pending Dev", "indeterminate", [C1])] }, { store: f.store, secret: SECRET });
  assertEquals(f.updates[0].patch.last_seen_status, "Pending Dev");
  assertEquals(f.updates[0].patch.silent_baseline, false);
});

Deno.test("status change and new comments only advance the panel baseline", async () => {
  const seen = { last_seen_status: "Pending Dev", last_seen_comment_at: "2026-10-18T18:00:00.000Z" };
  const f = fakes([link(seen)]);
  await handleJiraSync(SECRET, { issues: [raw("In Review", "indeterminate", [C1, C2])] }, { store: f.store, secret: SECRET });
  assertEquals(f.updates.length, 1);
  assertEquals(f.updates[0].patch.last_seen_status, "In Review");
  assertEquals(f.updates[0].patch.last_seen_comment_at, "2026-10-18T19:00:00.000Z"); // C2: 02:00+0700 → 19:00Z hôm trước
});

Deno.test("payload missing the newest comment must NOT rewind the comment watermark", async () => {
  // C2 (19:00Z) đã thấy ở lượt trước; lượt này payload chỉ còn C1 (comment bị
  // xoá trên Jira / search trả thiếu) NHƯNG có đổi status → kind = update.
  // Mốc comment phải giữ 19:00Z — ghi lùi về 18:00Z (hành vi cũ) sẽ khiến C2
  // bị tính là comment mới lại ở lượt sync sau (badge bật lại vô cớ).
  const seen = { last_seen_status: "Pending Dev", last_seen_comment_at: "2026-10-18T19:00:00.000Z" };
  const f = fakes([link(seen)]);
  await handleJiraSync(SECRET, { issues: [raw("In Review", "indeterminate", [C1])] }, { store: f.store, secret: SECRET });
  assertEquals(f.updates.length, 1);
  assertEquals(f.updates[0].patch.last_seen_status, "In Review");
  assertEquals(f.updates[0].patch.last_seen_comment_at, "2026-10-18T19:00:00.000Z");
});

Deno.test("nothing new -> no link update at all", async () => {
  const f = fakes([link({ last_seen_status: "Pending Dev", last_seen_comment_at: "2026-10-19T02:00:00.000Z" })]);
  const r = await handleJiraSync(SECRET, { issues: [raw("Pending Dev", "indeterminate", [C1, C2])] }, { store: f.store, secret: SECRET });
  assertEquals(r.body, { issues: 1 });
  assertEquals(f.updates, []);
});

Deno.test("done ticket WITHOUT a customer message after Done keeps the link active — the panel still owes the customer an update", async () => {
  // Ticket chuyển Done lúc 2026-10-19T03:00Z (mốc saveIssue đã lưu); tin CS
  // gần nhất trong chat là 01:00Z — TRƯỚC mốc Done → chưa báo khách.
  const f = fakes(
    [link({ last_seen_status: "Pending Dev", last_seen_comment_at: "2026-10-18T19:00:00.000Z" })],
    { stored: { status_changed_at: "2026-10-19T03:00:00.000Z", prev_status: "Pending Dev" }, lastHumanAt: "2026-10-19T01:00:00.000Z" },
  );
  await handleJiraSync(SECRET, { issues: [raw("Done", "done", [C1, C2])] }, { store: f.store, secret: SECRET });
  assertEquals(f.updates.length, 1);
  assertEquals(f.updates[0].patch.active, undefined); // KHÔNG tắt link
  assertEquals(f.updates[0].patch.last_seen_status, "Done");
});

Deno.test("done ticket with NO agent message at all in the chat also keeps the link active", async () => {
  const f = fakes(
    [link({ last_seen_status: "Pending Dev", last_seen_comment_at: "2026-10-18T19:00:00.000Z" })],
    { stored: { status_changed_at: "2026-10-19T03:00:00.000Z", prev_status: "Pending Dev" }, lastHumanAt: null },
  );
  await handleJiraSync(SECRET, { issues: [raw("Done", "done", [C1, C2])] }, { store: f.store, secret: SECRET });
  assertEquals(f.updates.length, 1);
  assertEquals(f.updates[0].patch.active, undefined);
});

Deno.test("done ticket + agent messaged the customer AFTER the Done transition -> link deactivated (cleanup only)", async () => {
  // Link đã ở mốc Done từ lượt trước (diff = none) nhưng CS mới nhắn khách lúc
  // 04:00Z, sau mốc Done 03:00Z → lượt sync này chỉ việc tắt link dọn dẹp.
  const f = fakes(
    [link({ last_seen_status: "Done", last_seen_comment_at: "2026-10-18T19:00:00.000Z" })],
    { stored: { status_changed_at: "2026-10-19T03:00:00.000Z", prev_status: "Pending Dev" }, lastHumanAt: "2026-10-19T04:00:00.000Z" },
  );
  await handleJiraSync(SECRET, { issues: [raw("Done", "done", [C1, C2])] }, { store: f.store, secret: SECRET });
  assertEquals(f.updates, [{ session_id: "session_1", patch: { active: false } }]);
});

Deno.test("malformed issues in the payload are skipped", async () => {
  const f = fakes([]);
  const r = await handleJiraSync(SECRET, { issues: [null, { nokey: 1 }, "x"] }, { store: f.store, secret: SECRET });
  assertEquals(r.body, { issues: 0 });
  assertEquals(f.saved, []);
});
