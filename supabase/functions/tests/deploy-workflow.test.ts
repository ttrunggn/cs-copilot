import { assert } from "jsr:@std/assert@1";

// GitHub Actions phải deploy đủ mọi Edge Function có index.ts, đều với --no-verify-jwt (widget/n8n tự xác thực).
const root = new URL("../../../", import.meta.url);
const yml = await Deno.readTextFile(new URL(".github/workflows/deploy-functions.yml", root));

Deno.test("deploy workflow deploys every Edge Function", async () => {
  for await (const e of Deno.readDir(new URL("supabase/functions/", root))) {
    if (!e.isDirectory || e.name.startsWith("_") || e.name === "tests") continue;
    try {
      await Deno.stat(new URL(`supabase/functions/${e.name}/index.ts`, root));
    } catch {
      continue;
    }
    assert(yml.includes(`functions deploy ${e.name} `), `missing deploy for ${e.name}`);
  }
});

Deno.test("deploy workflow runs the tests first and keeps secrets out of the file", () => {
  assert(yml.includes("deno task test"));
  assert(yml.includes("needs: test"));
  assert(yml.includes("secrets.SUPABASE_ACCESS_TOKEN"));
  assert(!/sbp_[0-9a-f]{10,}/.test(yml));
  for (const line of yml.split("\n").filter((l) => l.includes("functions deploy"))) assert(line.includes("--no-verify-jwt"), line);
});
