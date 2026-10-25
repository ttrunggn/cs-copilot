import { assertEquals } from "jsr:@std/assert@1";
import { createDb } from "../_shared/db.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Client Supabase giả tối giản cho createDb: mọi method query-builder trả về
// chính chain, chain là thenable resolve { data: rows[table], error: null }.
// Đủ cho getJiraRows (select/eq/in/order) và unlinkJira (update/eq/select).
function fakeSb(tables: Record<string, unknown[]>) {
  const from = (table: string) => {
    const result = { data: tables[table] ?? [], error: null };
    // deno-lint-ignore no-explicit-any
    const chain: any = {};
    for (const m of ["select", "eq", "in", "order", "update", "upsert"]) chain[m] = () => chain;
    chain.then = (resolve: (v: typeof result) => void) => resolve(result);
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

const LINK = (key: string, active: boolean) => ({
  website_id: "ws1",
  session_id: "session_1",
  issue_key: key,
  url: `https://firegroup.atlassian.net/browse/${key}`,
  silent_baseline: false,
  last_seen_status: "Open",
  last_seen_comment_at: null,
  active,
});

Deno.test("getJiraRows: chỉ trả link đang active — link đã gỡ tay và link Done-đã-báo-khách (sync đã tắt) đều ẩn", async () => {
  const db = createDb(fakeSb({
    jira_links: [LINK("TNT-1", true), LINK("TNT-2", false), LINK("OES-3", true)],
    jira_issues: [],
    jira_comments: [],
  }));
  const rows = await db.getJiraRows("ws1", "session_1");
  assertEquals(rows.map((r) => r.link.issue_key), ["TNT-1", "OES-3"]);
});

Deno.test("getJiraRows: issue mang theo status_category + prev_status để phía đọc phân biệt Done và hiện 'từ → mới'", async () => {
  const db = createDb(fakeSb({
    jira_links: [LINK("TNT-1", true)],
    jira_issues: [{
      issue_key: "TNT-1", summary: "Bug", status: "Done", status_category: "done", assignee: null,
      updated_at: null, status_changed_at: "2026-10-19T03:00:00.000Z", prev_status: "In Progress",
    }],
    jira_comments: [],
  }));
  const rows = await db.getJiraRows("ws1", "session_1");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].issue?.status_category, "done");
  assertEquals(rows[0].issue?.prev_status, "In Progress");
});

Deno.test("getJiraRows: mọi link đều inactive -> rỗng (module Jira tự ẩn ở check)", async () => {
  const db = createDb(fakeSb({ jira_links: [LINK("TNT-2", false)], jira_issues: [], jira_comments: [] }));
  assertEquals(await db.getJiraRows("ws1", "session_1"), []);
});

Deno.test("unlinkJira: có dòng được tắt -> true; không có dòng nào -> false", async () => {
  const hit = createDb(fakeSb({ jira_links: [{ issue_key: "TNT-1" }] }));
  assertEquals(await hit.unlinkJira("ws1", "session_1", "TNT-1"), true);
  const miss = createDb(fakeSb({ jira_links: [] }));
  assertEquals(await miss.unlinkJira("ws1", "session_1", "TNT-9"), false);
});
