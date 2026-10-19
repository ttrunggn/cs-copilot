import { assert, assertEquals } from "jsr:@std/assert@1";

const FILES = ["ingest-crisp.json", "copilot-refresh.json", "copilot-post-note.json", "crisp-sync.json", "helpdesk-sync.json", "copilot-gateway.json"];
const dir = new URL(".", import.meta.url);

interface Node { name: string; type: string; typeVersion: number; parameters: Record<string, unknown>; credentials?: Record<string, { id: string }> }
interface Wf { name: string; nodes: Node[]; connections: Record<string, { main: { node: string }[][] }> }

for (const file of FILES) {
  Deno.test(`${file}: valid workflow structure`, async () => {
    const wf: Wf = JSON.parse(await Deno.readTextFile(new URL(file, dir)));
    const names = wf.nodes.map((n) => n.name);
    assertEquals(new Set(names).size, names.length, "node names must be unique");
    for (const n of wf.nodes) assert(n.type && n.typeVersion, `${n.name} missing type/typeVersion`);
    for (const [src, conn] of Object.entries(wf.connections)) {
      assert(names.includes(src), `connection source ${src} not a node`);
      for (const branch of conn.main) for (const t of branch) assert(names.includes(t.node), `target ${t.node} not a node`);
    }
    for (const n of wf.nodes) {
      for (const c of Object.values(n.credentials ?? {})) assert(c.id.startsWith("REPLACE_"), `${n.name} has a real credential id`);
    }
    const needsResponder = wf.nodes.some((n) => n.type === "n8n-nodes-base.webhook" && n.parameters.responseMode === "responseNode");
    if (needsResponder) assert(wf.nodes.some((n) => n.type === "n8n-nodes-base.respondToWebhook"), "missing Respond to Webhook");
  });
}

Deno.test("Supabase calls use n8n's built-in Supabase API credential", async () => {
  for (const file of FILES) {
    const wf: Wf = JSON.parse(await Deno.readTextFile(new URL(file, dir)));
    for (const n of wf.nodes) {
      if (!String(n.parameters.url ?? "").includes("supabase.co")) continue;
      assertEquals(n.parameters.authentication, "predefinedCredentialType", `${file}: ${n.name}`);
      assertEquals(n.parameters.nodeCredentialType, "supabaseApi", `${file}: ${n.name}`);
      assert(n.credentials?.supabaseApi, `${file}: ${n.name} missing supabaseApi credential`);
    }
  }
});
