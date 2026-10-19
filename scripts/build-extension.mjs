// Build extension chèn draft: điền WIDGET_ORIGIN, gộp composer-core.js vào từng content script (MV3 content
// script không chạy ES module), ghi extension/dist/ và nén thành widget/extension.zip để team tải về.
// Chạy: node --env-file=.env scripts/build-extension.mjs
const ORIGIN = /^https:\/\/[a-z0-9.-]+$/i;

export function checkOrigin(value) {
  const v = String(value ?? "").trim().replace(/\/$/, "");
  if (!ORIGIN.test(v)) throw new Error(`WIDGET_ORIGIN phải dạng https://<site>.netlify.app, đang là "${value ?? ""}"`);
  return v;
}

export function renderManifest(template, origin) {
  return template.replaceAll("__WIDGET_ORIGIN__", origin);
}

export function bundle(core, script, origin) {
  return `${core.replace(/^export /gm, "")}\n\n${script.replaceAll("__WIDGET_ORIGIN__", origin)}`;
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("build-extension.mjs")) {
  const { readFileSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const origin = checkOrigin(process.env.WIDGET_ORIGIN);
  const src = new URL("../extension/", import.meta.url);
  const dist = new URL("../extension/dist/", import.meta.url);
  const zip = fileURLToPath(new URL("../widget/extension.zip", import.meta.url));
  const read = (f) => readFileSync(new URL(f, src), "utf8");

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const core = read("composer-core.js");
  writeFileSync(new URL("manifest.json", dist), renderManifest(read("manifest.template.json"), origin));
  writeFileSync(new URL("composer.js", dist), bundle(core, read("composer.js"), origin));
  writeFileSync(new URL("bridge.js", dist), bundle(core, read("bridge.js"), origin));
  writeFileSync(new URL("background.js", dist), read("background.js"));

  rmSync(zip, { force: true });
  const distPath = fileURLToPath(dist);
  const r = process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${distPath}*' -DestinationPath '${zip}'`], { stdio: "inherit" })
    : spawnSync("zip", ["-r", "-j", zip, "."], { cwd: distPath, stdio: "inherit" });
  if (r.status !== 0) throw new Error("Không nén được extension.zip");
  console.log(`extension/dist + widget/extension.zip (WIDGET_ORIGIN=${origin})`);
}
