import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { bundle, checkOrigin, renderManifest } from "../scripts/build-extension.mjs";

Deno.test("checkOrigin accepts a bare https origin only", () => {
  assertEquals(checkOrigin("https://copilot-oe.netlify.app"), "https://copilot-oe.netlify.app");
  assertEquals(checkOrigin("https://copilot-oe.netlify.app/"), "https://copilot-oe.netlify.app");
  for (const bad of ["", "http://x.netlify.app", "https://x.netlify.app/index.html", "https://*.netlify.app", undefined]) {
    assertThrows(() => checkOrigin(bad), Error, undefined, String(bad));
  }
});

Deno.test("renderManifest fills the widget origin and asks for no permissions", async () => {
  const tpl = await Deno.readTextFile(new URL("./manifest.template.json", import.meta.url));
  const m = JSON.parse(renderManifest(tpl, "https://copilot-oe.netlify.app"));
  assertEquals(m.content_scripts[1].matches, ["https://copilot-oe.netlify.app/*"]);
  assertEquals(m.permissions, undefined);
  assertEquals(m.host_permissions, undefined);
});

Deno.test("bundle inlines the core without export keywords and fills the origin", () => {
  const out = bundle("export function a() {}\nexport const B = 1;", 'const O = "__WIDGET_ORIGIN__"; a();', "https://w.netlify.app");
  assertEquals(out.includes("export "), false);
  assertEquals(out.includes("function a() {}"), true);
  assertEquals(out.includes('"https://w.netlify.app"'), true);
});
