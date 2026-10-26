import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createJiraClient, JiraApiError, jiraFromEnv } from "../_shared/jira-api.ts";

// Client Jira REST chỉ-đọc: đúng endpoint search của workflow n8n cũ, đúng
// fields, Basic auth email:token. Key sai định dạng bị lọc trước khi gọi.

function fakeFetch(capture: { url?: string; init?: RequestInit }, status = 200, payload: unknown = { issues: [{ key: "TNT-1" }] }) {
  return (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init;
    return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }));
  };
}

Deno.test("jira-api: POST search/jql với Basic auth và fields như n8n", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const c = createJiraClient({ baseUrl: "https://firegroup.atlassian.net/", email: "a@b.c", apiToken: "tok", fetch: fakeFetch(cap) as typeof fetch });
  const issues = await c.searchIssues(["TNT-1", "TNT-2"]);
  assertEquals(cap.url, "https://firegroup.atlassian.net/rest/api/3/search/jql");
  const headers = (cap.init?.headers ?? {}) as Record<string, string>;
  assertEquals(headers.authorization, `Basic ${btoa("a@b.c:tok")}`);
  const body = JSON.parse(String(cap.init?.body));
  assertEquals(body.jql, "key in (TNT-1,TNT-2)");
  assertEquals(body.fields, ["summary", "status", "assignee", "updated", "comment"]);
  assertEquals(issues.length, 1);
});

Deno.test("jira-api: key sai định dạng bị lọc; không còn key nào thì không gọi Jira", async () => {
  let calls = 0;
  const c = createJiraClient({
    baseUrl: "https://x.atlassian.net", email: "a@b.c", apiToken: "t",
    fetch: (() => { calls++; return Promise.resolve(new Response("{}", { status: 200 })); }) as typeof fetch,
  });
  assertEquals(await c.searchIssues(["rác); DROP", "tnt-1"]), []);
  assertEquals(calls, 0);
});

Deno.test("jira-api: HTTP lỗi -> JiraApiError kèm mã trạng thái", async () => {
  const cap: { url?: string; init?: RequestInit } = {};
  const c = createJiraClient({ baseUrl: "https://x.atlassian.net", email: "a@b.c", apiToken: "t", fetch: fakeFetch(cap, 500, {}) as typeof fetch });
  await assertRejects(() => c.searchIssues(["TNT-1"]), JiraApiError, "HTTP 500");
});

Deno.test("jira-api: jiraFromEnv thiếu credential -> null; đủ -> client", () => {
  assertEquals(jiraFromEnv(() => undefined), null);
  assertEquals(jiraFromEnv((k) => k === "JIRA_EMAIL" ? "a@b.c" : undefined), null);
  const c = jiraFromEnv((k) => ({ JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" } as Record<string, string>)[k]);
  assert(c !== null);
});
