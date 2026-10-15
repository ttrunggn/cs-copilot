import { assert, assertEquals } from "jsr:@std/assert@1";

const FILES = ["ingest-crisp.json", "copilot-refresh.json", "copilot-post-note.json", "crisp-sync.json", "copilot-gateway.json"];
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
