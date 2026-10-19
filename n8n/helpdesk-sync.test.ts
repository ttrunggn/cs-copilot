import { assert, assertEquals } from "jsr:@std/assert@1";

// Đồng bộ helpdesk hằng đêm: chỉ bài published, chỉ tải lại bài đã đổi, rồi gọi embed-helpdesk.
const wf = JSON.parse(await Deno.readTextFile(new URL("./helpdesk-sync.json", import.meta.url)));
const node = (name: string) => wf.nodes.find((n: { name: string }) => n.name === name);

type Item = { json: unknown };
function runCode(name: string, items: Item[], refs: Record<string, (i: number) => unknown>): Promise<Item[]> {
  const code: string = node(name).parameters.jsCode;
  const fn = new Function("$input", "$", `return (async function () { ${code} }).call(this);`);
  const $ = (n: string) => ({ itemMatching: (i: number) => ({ json: refs[n](i) }) });
  return fn.call({}, { all: () => items }, $);
}

const WS = { website_id: "ws1", helpdesk_locale: "en" };

Deno.test("helpdesk-sync chain is in the expected order", () => {
  const next = (n: string) => wf.connections[n]?.main[0].map((t: { node: string }) => t.node);
  assertEquals(next("Nightly"), ["Get Workspaces"]);
  assertEquals(next("Run Manually"), ["Get Workspaces"]);
  const chain = ["Get Workspaces", "List Articles", "Build List", "Find Stale", "Split Stale", "Get Article", "Build Articles", "Upsert Articles", "Embed"];
  for (let i = 0; i < chain.length - 1; i++) assertEquals(next(chain[i]), [chain[i + 1]], chain[i]);
});

Deno.test("helpdesk-sync filters published articles only", async () => {
  const page = {
    data: [
      { article_id: "a1", status: "draft", updated_at: 1, title: "D", url: "u1" },
      { article_id: "a2", status: "unpublished", updated_at: 2, title: "U", url: "u2" },
      { article_id: "a3", status: "published", updated_at: 3, title: "P", url: "u3", category: { name: "Getting Started" } },
    ],
  };
  const out = await runCode("Build List", [{ json: page }], { "Get Workspaces": () => WS });
  assertEquals(out.length, 1);
  const g = out[0].json as { website_id: string; locale: string; list: unknown[]; meta: Record<string, unknown> };
  assertEquals([g.website_id, g.locale], ["ws1", "en"]);
  assertEquals(g.list, [{ article_id: "a3", updated_at: 3 }]);
  assertEquals(g.meta, { a3: { title: "P", url: "u3", category: "Getting Started" } });
});

Deno.test("Build List merges all pages of one workspace", async () => {
  const p = (id: string) => ({ json: { data: [{ article_id: id, status: "published", updated_at: 1, title: id, url: id }] } });
  const out = await runCode("Build List", [p("a1"), p("a2")], { "Get Workspaces": () => WS });
  assertEquals(out.length, 1);
  assertEquals((out[0].json as { list: unknown[] }).list.length, 2);
});

Deno.test("Split Stale accepts the RPC result in any n8n item shape", async () => {
  const group = { website_id: "ws1", locale: "en", meta: { a1: { title: "T1", url: "u1", category: null }, a3: { title: "T3", url: "u3", category: "C" } } };
  for (const items of [[{ json: ["a1", "a3"] }], [{ json: { data: "a1" } }, { json: { data: "a3" } }], [{ json: { "0": "a1", "1": "a3" } }]]) {
    const out = await runCode("Split Stale", items, { "Build List": () => group });
    assertEquals(out.map((o) => (o.json as { article_id: string }).article_id), ["a1", "a3"], JSON.stringify(items));
    assertEquals(out[1].json, { website_id: "ws1", locale: "en", article_id: "a3", title: "T3", url: "u3", category: "C" });
  }
});

Deno.test("Build Articles groups fetched articles per workspace and skips failures", async () => {
  const stale = [
    { website_id: "ws1", locale: "en", article_id: "a1", title: "T1", url: "u1", category: "C" },
    { website_id: "ws1", locale: "en", article_id: "a2", title: "T2", url: "u2", category: null },
  ];
  const out = await runCode("Build Articles", [
    { json: { data: { article_id: "a1", status: "published", title: "T1", url: "u1", content: "body", updated_at: 5 } } },
    { json: { error: "timeout" } },
  ], { "Split Stale": (i) => stale[i] });
  assertEquals(out, [{
    json: {
      p_website_id: "ws1",
      p_locale: "en",
      p_articles: [{ article_id: "a1", title: "T1", url: "u1", category: "C", content: "body", updated_at: 5 }],
    },
  }]);
});

Deno.test("Crisp requests use the plugin tier header and Embed sends the shared secret placeholder", () => {
  for (const n of wf.nodes) {
    const url = String(n.parameters.url ?? "");
    if (url.includes("api.crisp.chat")) {
      const h = n.parameters.headerParameters.parameters;
      assert(h.some((p: { name: string; value: string }) => p.name === "X-Crisp-Tier" && p.value === "plugin"), n.name);
    }
  }
  const embed = node("Embed");
  assertEquals(embed.parameters.url, "https://YOUR-PROJECT.supabase.co/functions/v1/embed-helpdesk");
  assert(embed.parameters.headerParameters.parameters.some((p: { name: string; value: string }) =>
    p.name === "x-copilot-secret" && p.value === "REPLACE_N8N_SHARED_SECRET"
  ));
});

Deno.test("no Code node uses require (n8n blocks the crypto module)", () => {
  for (const n of wf.nodes) assert(!String(n.parameters.jsCode ?? "").includes("require("), n.name);
});

Deno.test("embedding also runs on its own nightly schedule, even when no article changed", () => {
  const trigger = node("Embed Nightly");
  assertEquals(trigger.type, "n8n-nodes-base.scheduleTrigger");
  assertEquals(wf.connections["Embed Nightly"].main[0].map((t: { node: string }) => t.node), ["Embed Pending"]);
  const embed = node("Embed Pending");
  assertEquals(embed.parameters.url, "https://YOUR-PROJECT.supabase.co/functions/v1/embed-helpdesk");
  assert(embed.parameters.headerParameters.parameters.some((p: { name: string; value: string }) =>
    p.name === "x-copilot-secret" && p.value === "REPLACE_N8N_SHARED_SECRET"
  ));
});
