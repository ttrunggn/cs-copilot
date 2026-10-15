import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildGateway, SOURCES } from "./build-gateway.mjs";

const read = async (f: string) => JSON.parse(await Deno.readTextFile(new URL(`./${f}`, import.meta.url)));
const gateway = await read("copilot-gateway.json");

Deno.test("gateway is up to date with the 4 source workflows", async () => {
  const sources = await Promise.all(SOURCES.map((s: { file: string }) => read(s.file)));
  assertEquals(gateway, buildGateway(sources));
});

Deno.test("gateway keeps every node from every source", async () => {
  let total = 0;
  for (const s of SOURCES) total += (await read(s.file)).nodes.length;
  assertEquals(gateway.nodes.length, total);
});

Deno.test("every $('Node') reference in the gateway points to an existing node", () => {
  const names = new Set(gateway.nodes.map((n: { name: string }) => n.name));
  const refs = [...JSON.stringify(gateway.nodes).matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert(refs.length > 0);
  for (const r of refs) assert(names.has(r), `dangling reference $('${r}')`);
});

Deno.test("gateway has the 3 webhook paths the Edge Function and Crisp call", () => {
  const paths = gateway.nodes.filter((n: { type: string }) => n.type === "n8n-nodes-base.webhook")
    .map((n: { parameters: { path: string } }) => n.parameters.path).sort();
  assertEquals(paths, ["copilot-post-note", "copilot-refresh", "crisp-ingest-REPLACE-WITH-RANDOM"]);
});
