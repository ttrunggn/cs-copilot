import { assert, assertEquals } from "jsr:@std/assert@1";
import { bundle, checkOrigin, renderManifest } from "../scripts/build-extension.mjs";

// widget/extension.zip là bản team tải về từ panel: Netlify chỉ phục vụ thư
// mục widget/, không có bước build, nên zip phải commit sẵn và luôn khớp với
// mã nguồn trong extension/. Test này build lại nội dung kỳ vọng từ extension/
// (origin lấy từ chính manifest trong zip) rồi so từng file với zip đã commit,
// để sửa extension/ mà quên build lại zip là test đỏ ngay.

const read = (name) => Deno.readTextFile(new URL(`./${name}`, import.meta.url));

/** Giải nén zip thuần JS (store + deflate-raw) — test chỉ có --allow-read. */
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert(eocd >= 0, "không thấy end-of-central-directory trong extension.zip");
  const total = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map();
  for (let n = 0; n < total; n++) {
    assertEquals(view.getUint32(p, true), 0x02014b50, "central directory hỏng");
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)).replaceAll("\\", "/").split("/").pop();
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + size);
    let data = raw;
    if (method === 8) {
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    } else {
      assertEquals(method, 0, `zip dùng kiểu nén lạ: ${method}`);
    }
    if (name) files.set(name, new TextDecoder().decode(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

Deno.test("committed widget/extension.zip matches a fresh build of extension/", async () => {
  const zipBytes = await Deno.readFile(new URL("../widget/extension.zip", import.meta.url));
  const files = await unzip(zipBytes);

  const manifest = JSON.parse(files.get("manifest.json") ?? "{}");
  const matches = (manifest.content_scripts ?? []).flatMap((cs) => cs.matches ?? []);
  // content_scripts[0] khớp app.crisp.chat; origin của widget là match còn lại.
  const origin = checkOrigin(matches.find((m) => m.endsWith("/*") && !m.includes("crisp.chat"))?.slice(0, -2));

  const core = await read("composer-core.js");
  const expected = {
    "manifest.json": renderManifest(await read("manifest.template.json"), origin),
    "composer.js": bundle(core, await read("composer.js"), origin),
    "bridge.js": bundle(core, await read("bridge.js"), origin),
    "background.js": await read("background.js"),
  };

  assertEquals([...files.keys()].sort(), Object.keys(expected).sort(), "extension.zip chứa file lạ hoặc thiếu file — build lại bằng scripts/build-extension.mjs");
  for (const [name, content] of Object.entries(expected)) {
    assertEquals(files.get(name), content, `${name} trong extension.zip đã cũ so với extension/ — build lại bằng scripts/build-extension.mjs`);
  }
});
