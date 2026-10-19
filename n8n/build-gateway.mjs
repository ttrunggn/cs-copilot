// Gộp các workflow nguồn thành 1 workflow "Copilot v5 — Gateway" để import một lần.
// Tên node được thêm tiền tố để không trùng, và mọi tham chiếu $('Tên node') được đổi theo.
// Chạy: node n8n/build-gateway.mjs  (4 file nguồn vẫn là bản gốc, có test riêng)
export const SOURCES = [
  { file: "ingest-crisp.json", prefix: "Ingest" },
  { file: "copilot-refresh.json", prefix: "Refresh" },
  { file: "copilot-post-note.json", prefix: "Note" },
  { file: "crisp-sync.json", prefix: "Sync" },
  { file: "helpdesk-sync.json", prefix: "Helpdesk" },
];
const ROW_HEIGHT = 450;

function renameRefs(value, rename) {
  if (typeof value === "string") {
    return value.replace(/\$\('([^']+)'\)/g, (m, name) => (rename.has(name) ? `$('${rename.get(name)}')` : m));
  }
  if (Array.isArray(value)) return value.map((v) => renameRefs(v, rename));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameRefs(v, rename)]));
  }
  return value;
}

export function buildGateway(workflows) {
  const nodes = [];
  const connections = {};
  workflows.forEach((wf, row) => {
    const { prefix } = SOURCES[row];
    const rename = new Map(wf.nodes.map((n) => [n.name, `${prefix} · ${n.name}`]));
    for (const n of wf.nodes) {
      nodes.push({
        ...n,
        name: rename.get(n.name),
        parameters: renameRefs(n.parameters, rename),
        position: [n.position[0], n.position[1] + row * ROW_HEIGHT],
      });
    }
    for (const [src, conn] of Object.entries(wf.connections)) {
      connections[rename.get(src)] = {
        main: conn.main.map((branch) => branch.map((t) => ({ ...t, node: rename.get(t.node) }))),
      };
    }
  });
  return { name: "Copilot v5 — Gateway", nodes, connections, active: false, settings: { executionOrder: "v1" } };
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("build-gateway.mjs")) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const dir = new URL(".", import.meta.url);
  const wfs = SOURCES.map((s) => JSON.parse(readFileSync(new URL(s.file, dir), "utf8")));
  writeFileSync(new URL("copilot-gateway.json", dir), JSON.stringify(buildGateway(wfs), null, 2) + "\n");
  console.log("wrote n8n/copilot-gateway.json");
}
