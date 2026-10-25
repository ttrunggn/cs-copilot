import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

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

Deno.test("sync-now webhook joins the same scan chain and ends in Respond OK", () => {
  const next = (n: string) => wf.connections[n]?.main[0].map((t: { node: string }) => t.node);
  const hook = node("Sync Now Webhook");
  assertEquals(hook.type, "n8n-nodes-base.webhook");
  assertEquals(hook.parameters.httpMethod, "POST");
  assertEquals(hook.parameters.path, "jira-sync-now");
  assertEquals(hook.parameters.responseMode, "responseNode");
  assertEquals(next("Sync Now Webhook"), ["Verify Secret"]);
  assertEquals(next("Verify Secret"), ["Get Active Links"]);
  assertEquals(next("Jira Sync"), ["Respond OK"]);
  const respond = node("Respond OK");
  assertEquals(respond.type, "n8n-nodes-base.respondToWebhook");
  assertEquals(JSON.parse(respond.parameters.responseBody), { ok: true });
});

function runVerify(item: { json: unknown }): Promise<unknown[]> {
  const fn = new Function("$input", `return (async function () { ${node("Verify Secret").parameters.jsCode} }).call(this);`);
  return fn.call({}, { first: () => item });
}
const VERIFY_BODY = { website_id: "ws1", session_id: "session_1" };

Deno.test("Verify Secret: placeholder chưa thay -> fail closed; không dùng require", async () => {
  assertEquals(node("Verify Secret").parameters.jsCode.includes("require("), false);
  await assertRejects(
    () => runVerify({ json: { headers: { "x-copilot-secret": "REPLACE_N8N_SHARED_SECRET" }, body: VERIFY_BODY } }),
    Error,
    "chưa được cấu hình",
  );
});

Deno.test("Verify Secret: sai secret -> unauthorized; đúng secret + ids hợp lệ -> cho qua", async () => {
  const good = "0123456789abcdef0123456789abcdef";
  const original = node("Verify Secret").parameters.jsCode;
  node("Verify Secret").parameters.jsCode = original.replace("REPLACE_N8N_SHARED_SECRET", good);
  try {
    await assertRejects(
      () => runVerify({ json: { headers: { "x-copilot-secret": good.replace("0", "1") }, body: VERIFY_BODY } }),
      Error,
      "unauthorized",
    );
    await assertRejects(
      () => runVerify({ json: { headers: { "x-copilot-secret": good }, body: { website_id: "ws1", session_id: "x/y" } } }),
      Error,
      "bad input",
    );
    assertEquals(await runVerify({ json: { headers: { "x-copilot-secret": good }, body: VERIFY_BODY } }), [{ json: {} }]);
  } finally {
    node("Verify Secret").parameters.jsCode = original;
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
