import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const GOOD = "0123456789abcdef0123456789abcdef";
const BODY = { website_id: "ws1", session_id: "session_1", content: "🤖 note" };

async function verifyCode(file: string): Promise<string> {
  const wf = JSON.parse(await Deno.readTextFile(new URL(`./${file}`, import.meta.url)));
  return wf.nodes.find((n: { name: string }) => n.name === "Verify Secret").parameters.jsCode;
}

function run(code: string, headers: Record<string, string>): Promise<unknown[]> {
  const fn = new Function("$input", "require", "Buffer", `return (async function () { ${code} }).call(this);`);
  const req = (m: string) => (m === "crypto" ? { timingSafeEqual } : null);
  return fn.call({}, { first: () => ({ json: { headers, body: BODY } }) }, req, Buffer);
}

for (const file of ["copilot-refresh.json", "copilot-post-note.json"]) {
  Deno.test(`${file}: unreplaced placeholder secret fails closed`, async () => {
    const code = await verifyCode(file);
    await assertRejects(() => run(code, { "x-copilot-secret": "REPLACE_N8N_SHARED_SECRET" }), Error, "chưa được cấu hình");
  });

  Deno.test(`${file}: wrong secret is rejected`, async () => {
    const code = (await verifyCode(file)).replace("REPLACE_N8N_SHARED_SECRET", GOOD);
    await assertRejects(() => run(code, { "x-copilot-secret": GOOD.replace("0", "1") }), Error, "unauthorized");
  });

  Deno.test(`${file}: correct secret passes ids through`, async () => {
    const code = (await verifyCode(file)).replace("REPLACE_N8N_SHARED_SECRET", GOOD);
    const out = await run(code, { "x-copilot-secret": GOOD }) as { json: { website_id: string; session_id: string } }[];
    assertEquals([out[0].json.website_id, out[0].json.session_id], ["ws1", "session_1"]);
  });
}
