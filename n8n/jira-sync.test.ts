import { assert, assertEquals } from "jsr:@std/assert@1";

// Mỗi 5 phút: ticket đang theo dõi → Jira search → Edge Function jira-sync (logic so sánh + đăng note nằm ở Supabase).
const wf = JSON.parse(await Deno.readTextFile(new URL("./jira-sync.json", import.meta.url)));
const node = (name: string) => wf.nodes.find((n: { name: string }) => n.name === name);
type Item = { json: unknown };
function runCode(name: string, items: Item[]): Promise<Item[]> {
  const fn = new Function("$input", `return (async function () { ${node(name).parameters.jsCode} }).call(this);`);
  return fn.call({}, { all: () => items });
}

Deno.test("jira-sync chain order", () => {
  const next = (n: string) => wf.connections[n]?.main[0].map((t: { node: string }) => t.node);
  assertEquals(next("Every 5 Minutes"), ["Get Active Links"]);
  assertEquals(next("Run Manually"), ["Get Active Links"]);
  for (const [a, b] of [["Get Active Links", "Build JQL"], ["Build JQL", "Search Jira"], ["Search Jira", "Collect Issues"], ["Collect Issues", "Jira Sync"]]) {
    assertEquals(next(a), [b], a);
  }
});

Deno.test("Build JQL dedupes keys, rejects malformed ones and chunks by 50", async () => {
  const keys = Array.from({ length: 60 }, (_, i) => ({ json: { issue_key: `TNT-${i}` } }));
  const out = await runCode("Build JQL", [...keys, { json: { issue_key: "TNT-1" } }, { json: { issue_key: "bad key) OR 1=1" } }]);
  assertEquals(out.length, 2);
  const first = out[0].json as { jql: string };
  assertEquals(first.jql.startsWith("key in (TNT-0,TNT-1,"), true);
  assertEquals(first.jql.includes("bad"), false);
  assertEquals(await runCode("Build JQL", []), []);
});

Deno.test("Collect Issues merges every search page into one payload", async () => {
  const out = await runCode("Collect Issues", [{ json: { issues: [{ key: "TNT-1" }] } }, { json: { issues: [{ key: "TNT-2" }] } }, { json: {} }]);
  assertEquals(out, [{ json: { issues: [{ key: "TNT-1" }, { key: "TNT-2" }] } }]);
});

Deno.test("Jira search uses the Jira credential and asks only for the needed fields", () => {
  const s = node("Search Jira");
  assertEquals(s.parameters.url, "https://YOUR-JIRA.atlassian.net/rest/api/3/search/jql");
  assertEquals(s.parameters.nodeCredentialType, "jiraSoftwareCloudApi");
  assert(s.credentials.jiraSoftwareCloudApi.id.startsWith("REPLACE_"));
  assert(String(s.parameters.jsonBody).includes("summary") && String(s.parameters.jsonBody).includes("comment"));
});

Deno.test("Jira Sync posts to the Edge Function with the shared secret placeholder", () => {
  const j = node("Jira Sync");
  assertEquals(j.parameters.url, "https://YOUR-PROJECT.supabase.co/functions/v1/jira-sync");
  assert(j.parameters.headerParameters.parameters.some((p: { name: string; value: string }) => p.name === "x-copilot-secret" && p.value === "REPLACE_N8N_SHARED_SECRET"));
});

Deno.test("no Code node uses require (n8n blocks the crypto module)", () => {
  for (const n of wf.nodes) assert(!String(n.parameters.jsCode ?? "").includes("require("), n.name);
});
