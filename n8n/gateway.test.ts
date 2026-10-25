import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildGateway, SOURCES } from "./build-gateway.mjs";

const read = async (f: string) => JSON.parse(await Deno.readTextFile(new URL(`./${f}`, import.meta.url)));
const gateway = await read("copilot-gateway.json");

Deno.test("gateway is up to date with the 5 source workflows", async () => {
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

Deno.test("gateway has the webhook paths the Edge Function and Crisp call", () => {
  const paths = gateway.nodes.filter((n: { type: string }) => n.type === "n8n-nodes-base.webhook")
    .map((n: { parameters: { path: string } }) => n.parameters.path).sort();
  assertEquals(paths, ["copilot-refresh", "crisp-ingest-REPLACE-WITH-RANDOM", "jira-sync-now"]);
});

Deno.test("gateway has NO node that writes to Crisp (CRISP WRITE RULE)", () => {
  // Mọi lời gọi api.crisp.chat trong gateway phải là GET (đọc). Một node
  // POST/PATCH/PUT/DELETE vào Crisp nghĩa là tồn tại đường server tự đăng
  // lên Crisp — đúng thứ quy tắc cấm tuyệt đối (bài học vụ note Jira spam).
  for (const n of gateway.nodes) {
    const params = JSON.stringify(n.parameters ?? {});
    if (!params.includes("api.crisp.chat")) continue;
    const method = String((n.parameters as { method?: string }).method ?? "GET").toUpperCase();
    assertEquals(method, "GET", `${n.name} gọi Crisp bằng ${method} — gateway chỉ được ĐỌC Crisp`);
  }
});

Deno.test("gateway includes the helpdesk sync with its prefix", () => {
  assert(gateway.nodes.some((n: { name: string }) => n.name === "Helpdesk · Embed"));
});

Deno.test("gateway ingest nodes reference Filter Events by its gateway name (position-independent)", () => {
  const byName = (name: string) => gateway.nodes.find((n: { name: string }) => n.name === name);
  const ingestBody = String(byName("Ingest · Ingest Event").parameters.jsonBody ?? "");
  assert(ingestBody.includes("$('Ingest · Filter Events').first().json.p_event"), ingestBody);
  assert(!ingestBody.includes("$json.p_event"), ingestBody);
  const prepCode = String(byName("Ingest · Chuẩn bị precompute").parameters.jsCode ?? "");
  assert(prepCode.includes("$('Ingest · Filter Events').first().json.p_event"), prepCode);
  assert(!prepCode.includes("$json.p_event"), prepCode);
});
