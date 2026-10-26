import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { handleStorefrontSweep, runStorefrontSweep } from "../copilot/storefront-sweep.ts";
import {
  classifyFindings,
  createStorefrontMcp,
  findingNeedles,
  hmacSha256Hex,
  parseFindingDetailText,
  parseFindingsText,
  parseStoreText,
  StorefrontError,
  type StorefrontFinding,
  type StorefrontMcp,
  type StorefrontStore,
  type StorefrontStoreStatus,
  storefrontFromEnv,
  storeStatusFromStore,
  swSignature,
} from "../_shared/storefront.ts";
import { CONV, makeDeps, msg, TOKEN, WS } from "./fakes.ts";

const FP_A = "a".repeat(40);
const FP_B = "b".repeat(40);
const FP_C = "c".repeat(40);
const FP_D = "d".repeat(40);

function finding(fp: string, over: Partial<StorefrontFinding> = {}): StorefrontFinding {
  return { fingerprint: fp, title: "Lỗi", meta: "", severity: null, locale: null, page: null, text: null, ...over };
}

// ---------- chữ ký HMAC ----------

Deno.test("hmacSha256Hex: khớp known vector độc lập", async () => {
  const hex = await hmacSha256Hex("test-secret-storefront", `1700000000.ws-test.{"jsonrpc":"2.0","id":1,"method":"tools/list"}`);
  assertEquals(hex, "30a0ce48e9ebad3f2a6e96e1597348201f9273afa06615cf54325751d9657905");
});

Deno.test("swSignature: định dạng sha256= + ký đúng chuỗi {ts}.{website}.{body}", async () => {
  const sig = await swSignature("test-secret-storefront", "1700000000", "ws-test", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`);
  assertEquals(sig, "sha256=30a0ce48e9ebad3f2a6e96e1597348201f9273afa06615cf54325751d9657905");
});

// ---------- chia 3 trạng thái ----------

Deno.test("classifyFindings: ưu tiên Đang xử lý > Mới > Đã xác nhận, mỗi finding đúng 1 nhóm", () => {
  const findings = [
    finding(FP_A, { page: "/products/abc" }), // chưa seen + được CS nhắc → Đang xử lý (thắng Mới)
    finding(FP_D, { page: "/pages/size-guide" }), // đã seen + được CS nhắc → Đang xử lý (thắng Đã xác nhận)
    finding(FP_B, { page: "/pages/other" }), // đã seen, không nhắc → Đã xác nhận
    finding(FP_C, { page: "/pages/new-one" }), // chưa seen, không nhắc → Mới
  ];
  const seen = new Set([FP_B, FP_D]);
  const ops = ["Bên em đã xem /products/abc và /pages/size-guide cho anh rồi ạ"];
  const g = classifyFindings(findings, seen, ops);
  assertEquals(g.in_progress.map((f) => f.fingerprint), [FP_A, FP_D]);
  assertEquals(g.new.map((f) => f.fingerprint), [FP_C]);
  assertEquals(g.acknowledged.map((f) => f.fingerprint), [FP_B]);
});

Deno.test("classifyFindings: watermark — lần 2 (đã ghi mốc) thì finding cũ thành Đã xác nhận", () => {
  const findings = [finding(FP_C, { page: "/pages/new-one" })];
  const first = classifyFindings(findings, new Set(), []);
  assertEquals(first.new.length, 1);
  const second = classifyFindings(findings, new Set([FP_C]), []);
  assertEquals(second.new.length, 0);
  assertEquals(second.acknowledged.length, 1);
});

Deno.test("findingNeedles: URL đầy đủ cho thêm kim pathname; kim quá ngắn bị loại", () => {
  const needles = findingNeedles(finding(FP_A, { page: "https://shop-x.myshopify.com/products/abc?lang=de", text: "abc" }));
  assert(needles.some((n) => n === "/products/abc"));
  assert(!needles.includes("abc")); // text 3 ký tự < 8 → không thành kim
  assertEquals(findingNeedles(finding(FP_A, { page: "/ab" })), []); // path 3 ký tự < 4 → không có kim nào
});

Deno.test("classifyFindings: tin của khách/bot/note không tính là CS đã contact (chỉ operatorTexts được truyền vào)", () => {
  // Hàm chỉ nhận operatorTexts đã lọc ở action; ở đây kiểm chứng khớp text dài từ vùng lỗi.
  const f = finding(FP_A, { text: "Add to cart button overlaps the price" });
  const g = classifyFindings([f], new Set(), ["Em thấy nút Add to cart button overlaps the price rồi, đang xử lý ạ"]);
  assertEquals(g.in_progress.length, 1);
});

// ---------- parse prose thật của tool ----------
// Fixture chép ĐÚNG văn bản đã gọi live 2026-10-23 từ hai store đang được SW
// theo dõi (amirobeauty.com, iglow.me) — định dạng prose cố định của SW.

const AMIRO_STORE = `Store: amirobeauty.com
In the weekly sweep: yes
Languages: es, ja, zh · pages: 31
Last good check: 2026-10-22
Open problems: 3 critical, 6 high, 0 medium, 0 low`;

const AMIRO_LIST = `9 open problem(s) on amirobeauty.com, worst first:
1. CRITICAL · Region missing · ja / (1440px)
   Seen 2 time(s), first 2026-10-14, last 2026-10-22
   Fingerprint: aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7
   Console: https://sw.transcy.io/#/f/aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7
2. CRITICAL · Region missing · zh / (1440px)
   Seen 2 time(s), first 2026-10-14, last 2026-10-22
   Fingerprint: 5517ba1da2be48c228850f56a6741e9e30bd297b
   Console: https://sw.transcy.io/#/f/5517ba1da2be48c228850f56a6741e9e30bd297b
3. CRITICAL · Region missing · es / (1440px)
   Seen 2 time(s), first 2026-10-14, last 2026-10-22
   Fingerprint: f38202faad7e0a03f6ebf8c1fd5df56501690aed
   Console: https://sw.transcy.io/#/f/f38202faad7e0a03f6ebf8c1fd5df56501690aed
4. HIGH · Option unidentifiable · zh /products/amiro-oath-makeup-lighted-mirror (1440px)
   Seen 1 time(s), first 2026-10-22, last 2026-10-22
   Text: "Color"
   Fingerprint: 036a70d3e7321a4d179fe1db24d756d6b713e7ac
   Console: https://sw.transcy.io/#/f/036a70d3e7321a4d179fe1db24d756d6b713e7ac
5. HIGH · Graphic lost · es /products/amiro-mate-led-makeup-mirror (1440px)
   Seen 1 time(s), first 2026-10-22, last 2026-10-22
   Text: "Rosa", "Blanco"
   Fingerprint: 42bf44a1456a4a6e4e970daa7a714ce1b80accf9
   Console: https://sw.transcy.io/#/f/42bf44a1456a4a6e4e970daa7a714ce1b80accf9
6. HIGH · Graphic lost · zh /products/tatis-exclusive-amiro-spectra-led-face-mask (1440px)
   Seen 1 time(s), first 2026-10-15, last 2026-10-15
   Text: "真實", "假的"
   Fingerprint: db6348cc25e10335a4ce3c178deda8737734c16d
   Console: https://sw.transcy.io/#/f/db6348cc25e10335a4ce3c178deda8737734c16d
7. HIGH · Layout degraded · es /products/dmauamiro-o2-led-vanity-mirror (1440px)
   Seen 1 time(s), first 2026-10-15, last 2026-10-15
   Text: "negro", "Blanco"
   Fingerprint: 3628224935126736319ae0cfdd077026a7d5bfd3
   Console: https://sw.transcy.io/#/f/3628224935126736319ae0cfdd077026a7d5bfd3
8. HIGH · Option unidentifiable · zh /products/amiro-mate-led-makeup-mirror (1440px)
   Seen 1 time(s), first 2026-10-15, last 2026-10-15
   Text: "Color"
   Fingerprint: ee16a4e2600f278dc455132edc42746dd35bcdab
   Console: https://sw.transcy.io/#/f/ee16a4e2600f278dc455132edc42746dd35bcdab
9. HIGH · Block collapsed · zh /products/amiro-mate-led-makeup-mirror (1440px)
   Seen 1 time(s), first 2026-10-15, last 2026-10-15
   Text: "粉紅色的"
   Fingerprint: b037194bbe99fddc03116b836b6fd5e8dca46833
   Console: https://sw.transcy.io/#/f/b037194bbe99fddc03116b836b6fd5e8dca46833`;

const IGLOW_STORE = `Store: iglow.me
In the weekly sweep: yes
Languages: fi, sv · pages: 6
Last good check: 2026-10-22
Open problems: 3 critical, 0 high, 2 medium, 0 low`;

const IGLOW_LIST = `5 open problem(s) on iglow.me, worst first:
1. CRITICAL · Region missing · fi /products/iglow-boosting-mascara (1440px)
   Seen 1 time(s), first 2026-10-22, last 2026-10-22
   Fingerprint: bb9606abc4dbf9350bb6e5367a76f861ca877429
   Console: https://sw.transcy.io/#/f/bb9606abc4dbf9350bb6e5367a76f861ca877429
2. CRITICAL · Region missing · fi /products/3x-iglow-high-volume-mascara (1440px)
   Seen 1 time(s), first 2026-10-22, last 2026-10-22
   Fingerprint: 00e85dbb06191c2e6fc5252918489ec899cae327
   Console: https://sw.transcy.io/#/f/00e85dbb06191c2e6fc5252918489ec899cae327
3. CRITICAL · Region missing · fi /products/2x-iglow-high-volume-mascara (1440px)
   Seen 1 time(s), first 2026-10-22, last 2026-10-22
   Fingerprint: 273c5f260e4e97bf005ed2dd34c51016bc43ce82
   Console: https://sw.transcy.io/#/f/273c5f260e4e97bf005ed2dd34c51016bc43ce82
4. MEDIUM · Height jump · fi / (1440px)
   Seen 1 time(s), first 2026-10-22, last 2026-10-22
   Text: "TUOTEPAKETIT JA TARJOUKSET", "JÄLLEENMYYJÄT"
   Fingerprint: ecf6a7ba1a490105f99b610d748f3326be15ef1d
   Console: https://sw.transcy.io/#/f/ecf6a7ba1a490105f99b610d748f3326be15ef1d
5. MEDIUM · Height jump · sv / (1440px)
   Seen 1 time(s), first 2026-10-22, last 2026-10-22
   Text: "ÅTERFÖRSÄLJARE"
   Fingerprint: 479e57d8ab106fc1e3da4b0fe4278adba86b5575
   Console: https://sw.transcy.io/#/f/479e57d8ab106fc1e3da4b0fe4278adba86b5575`;

const DETAIL_LONG_JUDGE = `Finding 036a70d3e7321a4d179fe1db24d756d6b713e7ac
HIGH · Option unidentifiable (also Graphic lost)
Where: amirobeauty.com · zh · /products/amiro-oath-makeup-lighted-mirror · 1440px wide
State: open
Seen 1 time(s), first 2026-10-22, last 2026-10-22
Judge: confirmed, "In image 1, the variant picker shows two color swatches: one filled black circle (selected) and one white circle. In image 2, both circles appear as empty outlines with no color fill, making the two values visually indistinguishable."
Text in the broken area: "Color"
Console: https://sw.transcy.io/#/f/036a70d3e7321a4d179fe1db24d756d6b713e7ac`;

const DETAIL_SHORT_JUDGE = `Finding aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7
CRITICAL · Region missing
Where: amirobeauty.com · ja · / · 1440px wide
State: open
Seen 2 time(s), first 2026-10-14, last 2026-10-22
Judge: no_crops
Console: https://sw.transcy.io/#/f/aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7`;

Deno.test("parseStoreText: store có theo dõi — counts, languages, last check khớp mẫu thật", () => {
  const s = parseStoreText(AMIRO_STORE, "amirobeauty.com");
  assertEquals(s.watched, true);
  assertEquals(s.shop, "amirobeauty.com");
  assertEquals(s.lastCheckedAt, "2026-10-22");
  assertEquals(s.openBySeverity, { critical: 3, high: 6, medium: 0, low: 0 });
  assertEquals(s.languages, ["es", "ja", "zh"]);
  assertEquals(s.pagesChecked, 31);
});

Deno.test("parseStoreText: store không theo dõi → watched=false, không bịa số liệu", () => {
  const s = parseStoreText(
    "Store: example.myshopify.com\nStorefront Watch does not watch this store and has never scanned it.\nThat means nothing is known about it, not that it has no problems.",
    "example.myshopify.com",
  );
  assertEquals(s.watched, false);
  assertEquals(s.openBySeverity, {});
  assertEquals(s.lastCheckedAt, null);
});

Deno.test("parseFindingsText: amirobeauty — đủ 9 findings, field trích đúng từng loại dòng", () => {
  const out = parseFindingsText(AMIRO_LIST);
  assertEquals(out.length, 9);
  const f1 = out[0];
  assertEquals(f1.fingerprint, "aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7");
  assertEquals(f1.severity, "critical");
  assertEquals(f1.kind, "Region missing");
  assertEquals(f1.title, "Region missing");
  assertEquals(f1.locale, "ja");
  assertEquals(f1.page, "/");
  assertEquals(f1.widthPx, 1440);
  assertEquals(f1.seenCount, 2);
  assertEquals(f1.firstSeenAt, "2026-10-14");
  assertEquals(f1.lastSeenAt, "2026-10-22");
  assertEquals(f1.texts, []);
  assertEquals(f1.consoleLink, "https://sw.transcy.io/#/f/aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7");
  const f4 = out[3];
  assertEquals(f4.kind, "Option unidentifiable");
  assertEquals(f4.page, "/products/amiro-oath-makeup-lighted-mirror");
  assertEquals(f4.texts, ["Color"]);
  assertEquals(f4.text, "Color");
  assertEquals(f4.meta, "high · zh · /products/amiro-oath-makeup-lighted-mirror");
  const f5 = out[4];
  assertEquals(f5.texts, ["Rosa", "Blanco"]); // nhiều đoạn text trong một dòng Text:
  assertEquals(f5.text, "Rosa, Blanco");
});

Deno.test("parse: tổng counts của find_store khớp số findings của list_findings ở cả 2 store thật", () => {
  for (const [storeText, listText] of [[AMIRO_STORE, AMIRO_LIST], [IGLOW_STORE, IGLOW_LIST]] as const) {
    const s = parseStoreText(storeText, "x");
    const total = Object.values(s.openBySeverity).reduce((a, b) => a + b, 0);
    assertEquals(total, parseFindingsText(listText).length);
  }
});

Deno.test("parseFindingDetailText: Judge dài + also-kind + Text — trích đủ field chi tiết", () => {
  const d = parseFindingDetailText(DETAIL_LONG_JUDGE);
  assertEquals(d.fingerprint, "036a70d3e7321a4d179fe1db24d756d6b713e7ac");
  assertEquals(d.severity, "high");
  assertEquals(d.kind, "Option unidentifiable");
  assertEquals(d.alsoKinds, ["Graphic lost"]);
  assertEquals(d.locale, "zh");
  assertEquals(d.page, "/products/amiro-oath-makeup-lighted-mirror");
  assertEquals(d.widthPx, 1440);
  assertEquals(d.state, "open");
  assertEquals(d.dismissed, false);
  assertEquals(d.fixed, false);
  assertStringIncludes(d.judgement ?? "", "two color swatches");
  assertEquals(d.texts, ["Color"]);
  assertEquals(d.consoleLink, "https://sw.transcy.io/#/f/036a70d3e7321a4d179fe1db24d756d6b713e7ac");
});

Deno.test("parseFindingDetailText: Judge mã ngắn, không có dòng Text → texts rỗng, judgement nguyên văn", () => {
  const d = parseFindingDetailText(DETAIL_SHORT_JUDGE);
  assertEquals(d.judgement, "no_crops");
  assertEquals(d.texts, []);
  assertEquals(d.page, "/");
  assertEquals(d.seenCount, 2);
});

Deno.test("parseFindingDetailText: State khác open → giữ state thô + cờ dismissed/fixed (SUY DIỄN — chưa có mẫu state đóng thật)", () => {
  // Chưa từng gọi được get_finding của một finding đã đóng — fixture này suy
  // từ cùng mẫu State: của ca open, chỉ thay giá trị. Parser phải giữ state
  // để UI không hiển thị finding đã đóng như đang mở.
  const dismissed = parseFindingDetailText(DETAIL_SHORT_JUDGE.replace("State: open", "State: dismissed"));
  assertEquals(dismissed.state, "dismissed");
  assertEquals(dismissed.dismissed, true);
  assertEquals(dismissed.fixed, false);
  const fixed = parseFindingDetailText(DETAIL_SHORT_JUDGE.replace("State: open", "State: fixed"));
  assertEquals(fixed.state, "fixed");
  assertEquals(fixed.fixed, true);
});

Deno.test("parse: định dạng lạ / số đếm không khớp → StorefrontError, không bịa dữ liệu", () => {
  assertRejectsSync(() => parseStoreText("hoàn toàn lạ", "x"), StorefrontError);
  assertRejectsSync(() => parseFindingsText("hoàn toàn lạ"), StorefrontError);
  assertRejectsSync(() => parseFindingDetailText("hoàn toàn lạ"), StorefrontError);
  const mismatch = AMIRO_LIST.replace("9 open problem(s)", "8 open problem(s)");
  assertRejectsSync(() => parseFindingsText(mismatch), StorefrontError);
});

function assertRejectsSync(fn: () => unknown, cls: typeof StorefrontError) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = e instanceof cls;
  }
  assert(threw, "kỳ vọng StorefrontError");
}

Deno.test("classifyFindings trên dữ liệu thật amirobeauty: CS nhắc path product → đúng 3 findings của path đó Đang xử lý", () => {
  const findings = parseFindingsText(AMIRO_LIST);
  const g = classifyFindings(findings, new Set(), ["Dạ em đã báo khách về lỗi hiển thị ở /products/amiro-mate-led-makeup-mirror rồi ạ"]);
  assertEquals(g.in_progress.map((f) => f.fingerprint), [
    "42bf44a1456a4a6e4e970daa7a714ce1b80accf9",
    "ee16a4e2600f278dc455132edc42746dd35bcdab",
    "b037194bbe99fddc03116b836b6fd5e8dca46833",
  ]);
  assertEquals(g.new.length, 6);
  assertEquals(g.acknowledged.length, 0);
});

Deno.test("findingNeedles: kim text dài từ dữ liệu thật (iglow Height jump)", () => {
  const iglow = parseFindingsText(IGLOW_LIST);
  const needles = findingNeedles(iglow[3]);
  assert(needles.some((n) => n.includes("tuotepaketit ja tarjoukset")));
  assert(!needles.includes("/")); // page "/" quá ngắn → không thành kim
  const amiro = parseFindingsText(AMIRO_LIST);
  assertEquals(findingNeedles(amiro[3]).includes("color"), false); // "Color" 5 ký tự < 8
});

// ---------- MCP client (fetch giả) ----------

interface CapturedCall { body: string; headers: Record<string, string> }

function jsonResponse(body: unknown, status = 200, sessionId?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
  });
}

function stubFetch(responder: (body: Record<string, unknown>, n: number) => Response) {
  const calls: CapturedCall[] = [];
  const f = ((_url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ body: init.body, headers: init.headers });
    return Promise.resolve(responder(JSON.parse(init.body), calls.length));
  }) as unknown as typeof fetch;
  return { f, calls };
}

function okResponder(toolText: string): (body: Record<string, unknown>) => Response {
  return (body) => {
    if (body.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }, 200, "sess-1");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: toolText }] } });
  };
}

Deno.test("MCP client: initialize 1 lần, mọi request đều ký đúng trên đúng body gửi đi", async () => {
  const { f, calls } = stubFetch(okResponder(AMIRO_STORE));
  const mcp = createStorefrontMcp({ token: "tok-sw", signingSecret: "sec-sw", fetch: f, now: () => 1_700_000_000_000 });
  const store = await mcp.findStore("ws1", "amirobeauty.com");
  assertEquals(store.watched, true);
  assertEquals(store.shop, "amirobeauty.com");
  assertEquals(store.lastCheckedAt, "2026-10-22");
  assertEquals(store.openBySeverity, { critical: 3, high: 6, medium: 0, low: 0 });
  assertEquals(calls.length, 3); // initialize + notifications/initialized + tools/call
  for (const c of calls) {
    assertEquals(c.headers["authorization"], "Bearer tok-sw");
    assertEquals(c.headers["X-Crisp-Website-Id"], "ws1");
    assertEquals(c.headers["X-Crisp-Timestamp"], "1700000000");
    assertEquals(c.headers["X-Crisp-Signature"], await swSignature("sec-sw", "1700000000", "ws1", c.body));
  }
  assertEquals(JSON.parse(calls[2].body).params.name, "find_store");
  // Gọi tiếp: session được dùng lại, không initialize lần 2. (Stub trả cùng
  // một text cho mọi tool — ở đây chỉ kiểm wiring/session, parse đã phủ riêng.)
  await mcp.listFindings("ws1", "amirobeauty.com").catch(() => null);
  assertEquals(calls.length, 4);
  assertEquals(calls[3].headers["Mcp-Session-Id"], "sess-1");
});

Deno.test("MCP client: session khoá theo website — website khác phải initialize riêng, không dùng chung session", async () => {
  // initialize được ký bằng website đầu tiên; dùng chung session cho website
  // khác là rò ngữ cảnh giữa các workspace (rà soát 2026-10-23).
  let inits = 0;
  const { f, calls } = stubFetch((body) => {
    if (body.method === "initialize") {
      inits++;
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }, 200, `sess-init-${inits}`);
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: AMIRO_STORE }] } });
  });
  const mcp = createStorefrontMcp({ token: "t", signingSecret: "s", fetch: f });
  await mcp.findStore("ws1", "amirobeauty.com");
  await mcp.findStore("ws2", "amirobeauty.com");
  await mcp.findStore("ws1", "amirobeauty.com");
  assertEquals(inits, 2); // mỗi website đúng 1 initialize; lần 3 (ws1) dùng lại session của ws1
  const toolCalls = calls.filter((c) => JSON.parse(c.body).method === "tools/call");
  assertEquals(toolCalls.length, 3);
  assertEquals(toolCalls[0].headers["Mcp-Session-Id"], "sess-init-1");
  assertEquals(toolCalls[0].headers["X-Crisp-Website-Id"], "ws1");
  assertEquals(toolCalls[1].headers["Mcp-Session-Id"], "sess-init-2");
  assertEquals(toolCalls[1].headers["X-Crisp-Website-Id"], "ws2");
  assertEquals(toolCalls[2].headers["Mcp-Session-Id"], "sess-init-1");
});

Deno.test("MCP client: list_findings luôn gửi include_all=true và parse prose thật", async () => {
  const { f, calls } = stubFetch(okResponder(IGLOW_LIST));
  const mcp = createStorefrontMcp({ token: "t", signingSecret: "s", fetch: f });
  const out = await mcp.listFindings("ws1", "iglow.me");
  const toolCall = calls.map((c) => JSON.parse(c.body)).find((b) => b.method === "tools/call");
  assertEquals(toolCall.params.arguments, { shop: "iglow.me", include_all: true });
  assertEquals(out.length, 5);
  assertEquals(out[0].severity, "critical");
  assertEquals(out[3].severity, "medium");
  assertEquals(out[3].kind, "Height jump");
});

Deno.test("MCP client: HTTP 401 ở initialize → StorefrontError nói rõ, không nuốt", async () => {
  const { f } = stubFetch(() => jsonResponse({ message: "Unauthorized" }, 401));
  const mcp = createStorefrontMcp({ token: "t", signingSecret: "s", fetch: f });
  const err = await assertRejects(() => mcp.findStore("ws1", "x.myshopify.com"), StorefrontError);
  assertStringIncludes(err.message, "401");
});

Deno.test("MCP client: JSON-RPC error và isError đều thành StorefrontError có nội dung", async () => {
  const rpcErr = stubFetch((body) => body.method === "initialize"
    ? jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, 200, "s1")
    : jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "shop không hợp lệ" } }));
  const mcp1 = createStorefrontMcp({ token: "t", signingSecret: "s", fetch: rpcErr.f });
  const e1 = await assertRejects(() => mcp1.findStore("ws1", "x"), StorefrontError);
  assertStringIncludes(e1.message, "shop không hợp lệ");

  const toolErr = stubFetch(okResponderToolError());
  const mcp2 = createStorefrontMcp({ token: "t", signingSecret: "s", fetch: toolErr.f });
  const e2 = await assertRejects(() => mcp2.getFinding("ws1", FP_A), StorefrontError);
  assertStringIncludes(e2.message, "không tìm thấy finding");
});

function okResponderToolError(): (body: Record<string, unknown>) => Response {
  return (body) => {
    if (body.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, 200, "s1");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "không tìm thấy finding" }] } });
  };
}

Deno.test("storefrontFromEnv: thiếu token hoặc secret → null; đủ cả hai → client", () => {
  assertEquals(storefrontFromEnv(() => undefined), null);
  assertEquals(storefrontFromEnv((k) => k === "SW_API_TOKEN" ? "tok" : undefined), null);
  assertEquals(storefrontFromEnv((k) => k === "SW_MCP_SIGNING_SECRET" ? "sec" : undefined), null);
  assert(storefrontFromEnv(() => "x") !== null);
});

// ---------- action qua handler ----------

const TNT_LINK = {
  link: {
    website_id: "ws1",
    session_id: "session_1",
    issue_key: "TNT-123",
    url: "https://firegroup.atlassian.net/browse/TNT-123",
    silent_baseline: false,
    last_seen_status: null,
    last_seen_comment_at: null,
  },
  issue: null,
};

function fakeMcp(over: Partial<StorefrontMcp> = {}): StorefrontMcp {
  return {
    findStore: () => Promise.resolve({ watched: true, shop: "shop-x.myshopify.com", lastCheckedAt: "2026-10-23T07:00:00Z", openBySeverity: { high: 3 }, uncheckedPages: [] }),
    listFindings: () => Promise.resolve([]),
    getFinding: () => Promise.resolve({
      fingerprint: FP_A, title: "Lỗi", meta: "", severity: "high", locale: "de", page: "/products/abc", text: "nội dung lỗi",
      where: "/products/abc", judgement: "judge thấy chồng chữ", dismissed: false, fixed: false, consoleLink: "https://sw.transcy.io/console/1",
    }),
    ...over,
  };
}

function sfDeps(mcp: StorefrontMcp | null, dbOver = {}, messages = [msg("user", "giúp em", 1), msg("operator", "Bên em đã xem /products/abc cho anh rồi ạ", 2)]) {
  const marked: string[][] = [];
  const made = makeDeps({
    messages,
    db: {
      getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT", storefront_watch: true }),
      getJiraRows: () => Promise.resolve([TNT_LINK]),
      getStorefrontSeen: () => Promise.resolve([FP_B, FP_D]),
      markStorefrontSeen: (_w: string, fps: string[]) => {
        marked.push(fps);
        return Promise.resolve();
      },
      ...dbOver,
    },
  });
  return { deps: { ...made.deps, storefront: mcp }, marked };
}

const SF_REQ = { website_id: "ws1", session_id: "session_1", action: "storefront", shop: "shop-x.myshopify.com" };

Deno.test("action storefront: module chưa bật (không có ticket TNT) → 403 rõ ràng", async () => {
  const made = makeDeps({ db: { getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT" }) } });
  const r = await handle(SF_REQ, TOKEN, { ...made.deps, storefront: fakeMcp() });
  assertEquals(r.status, 403);
});

Deno.test("action storefront: chưa cấu hình env → 200 status unconfigured, không gọi MCP", async () => {
  const { deps } = sfDeps(null);
  const r = await handle(SF_REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  const body = r.body as { status: string; error: string };
  assertEquals(body.status, "unconfigured");
  assertStringIncludes(body.error, "SW_API_TOKEN");
});

Deno.test("action storefront: chia 3 trạng thái + ghi mốc sau khi gom nhóm", async () => {
  const findings = [
    finding(FP_A, { page: "/products/abc", title: "Chồng chữ ở trang product" }), // operator đã nhắc → Đang xử lý
    finding(FP_B, { page: "/pages/other", title: "Lỗi đã thấy" }), // đã seen → Đã xác nhận
    finding(FP_C, { page: "/pages/new", title: "Lỗi mới tinh" }), // chưa seen → Mới
    finding(FP_D, { page: "/products/abc", title: "Lỗi đã seen nhưng CS đang xử lý" }), // seen + nhắc → Đang xử lý
  ];
  const { deps, marked } = sfDeps(fakeMcp({ listFindings: () => Promise.resolve(findings) }));
  const r = await handle(SF_REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  const body = r.body as { status: string; scanned_at: string | null; groups: Record<string, { fingerprint: string }[]> };
  assertEquals(body.status, "ok");
  assertEquals(body.scanned_at, "2026-10-23T07:00:00Z");
  assertEquals(body.groups.in_progress.map((g) => g.fingerprint), [FP_A, FP_D]);
  assertEquals(body.groups.acknowledged.map((g) => g.fingerprint), [FP_B]);
  assertEquals(body.groups.new.map((g) => g.fingerprint), [FP_C]);
  assertEquals(marked, [[FP_A, FP_B, FP_C, FP_D]]); // ghi mốc đủ 4 fingerprint sau khi gom
});

Deno.test("action storefront: store chưa được SW theo dõi → not_watched, không bịa lỗi", async () => {
  const { deps } = sfDeps(fakeMcp({
    findStore: () => Promise.resolve({ watched: false, shop: "shop-x.myshopify.com", lastCheckedAt: null, openBySeverity: {}, uncheckedPages: [] }),
  }));
  const r = await handle(SF_REQ, TOKEN, deps);
  const body = r.body as { status: string; groups: Record<string, unknown[]> };
  assertEquals(body.status, "not_watched");
  assertEquals(body.groups.new.length + body.groups.acknowledged.length + body.groups.in_progress.length, 0);
});

Deno.test("action storefront: MCP lỗi → status error kèm message trung thực", async () => {
  const { deps } = sfDeps(fakeMcp({
    findStore: () => Promise.reject(new StorefrontError("Storefront Watch trả HTTP 503 cho tools/call")),
  }));
  const r = await handle(SF_REQ, TOKEN, deps);
  const body = r.body as { status: string; error: string };
  assertEquals(body.status, "error");
  assertStringIncludes(body.error, "503");
});

Deno.test("action storefront: shop rác truyền lên → 400 trước khi gọi MCP", async () => {
  const { deps } = sfDeps(fakeMcp());
  // (shop dài > 300 ký tự bị handler cắt về 300 theo pattern hint/question — không thuộc ca rác ở đây.
  // shop rỗng/vắng không còn là rác: nghĩa là "tự resolve từ custom data" — phủ ở các test dưới.)
  for (const shop of ["ab", "có khoảng trắng.com"]) {
    const r = await handle({ ...SF_REQ, shop }, TOKEN, deps);
    assertEquals(r.status, 400, shop.slice(0, 20));
  }
});

Deno.test("action storefront: không truyền shop → tự resolve shopify_domain từ custom data của phiên", async () => {
  let seenShop = "";
  const { deps } = sfDeps(fakeMcp({
    findStore: (_w: string, shop: string) => {
      seenShop = shop;
      return Promise.resolve({ watched: true, shop, lastCheckedAt: "2026-10-23T07:00:00Z", openBySeverity: {}, uncheckedPages: [] });
    },
  }), {
    getConversation: () => Promise.resolve({ ...CONV, custom_data: { shopify_domain: "resolved.myshopify.com", tc_plan: "Cross-Border" } }),
  });
  const { shop: _omit, ...noShopReq } = SF_REQ;
  const r = await handle(noShopReq, TOKEN, deps);
  assertEquals(r.status, 200);
  const body = r.body as { status: string; store: string | null };
  assertEquals(body.status, "ok");
  assertEquals(seenShop, "resolved.myshopify.com");
  assertEquals(body.store, "resolved.myshopify.com");
});

Deno.test("action storefront: shopify_domain trong custom data THẮNG shop truyền lên (store của chính chat là nguồn sự thật)", async () => {
  // Đảo ngược so với hành vi cũ (rà soát 2026-10-23): shop tay thắng tuyệt đối
  // khiến một chat xem được findings của store bất kỳ — lẫn dữ liệu giữa các
  // store. Nay custom data của chính conversation thắng; shop truyền lên chỉ
  // còn là fallback khi custom data trống (phủ ở test need_shop/fallback dưới).
  let seenShop = "";
  const { deps } = sfDeps(fakeMcp({
    findStore: (_w: string, shop: string) => {
      seenShop = shop;
      return Promise.resolve({ watched: true, shop, lastCheckedAt: null, openBySeverity: {}, uncheckedPages: [] });
    },
  }), {
    getConversation: () => Promise.resolve({ ...CONV, custom_data: { shopify_domain: "resolved.myshopify.com" } }),
  });
  const r = await handle(SF_REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(seenShop, "resolved.myshopify.com");
});

Deno.test("action storefront: cổng action khớp cổng check — workspace cờ TẮT, ticket Done ĐÃ báo khách thì action cũng 403", async () => {
  // check loại ticket Done-đã-báo khỏi danh sách → modules.storefront = false.
  // Action từng tính cổng bằng jiraForConversation(rows, null) nên vẫn cho qua
  // đúng ca này; nay action dùng cùng mốc CS nhắn khách như check. Ca này xét
  // ở workspace cờ storefront_watch TẮT (đường ticket là đường duy nhất) —
  // workspace Transcy cờ bật thì module luôn mở theo chốt 2026-10-26.
  const doneRow = {
    link: { ...TNT_LINK.link },
    issue: {
      issue_key: "TNT-123", summary: "Bug", status: "Done", status_category: "done", assignee: null,
      updated_at: null, status_changed_at: "2026-10-20T00:00:00.000Z", prev_status: "In Progress", comments: [],
    },
  };
  const { deps } = sfDeps(fakeMcp(), {
    getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT", storefront_watch: false }),
    getJiraRows: () => Promise.resolve([doneRow]),
    getConversation: () => Promise.resolve({ ...CONV, last_human_operator_at: "2026-10-21T00:00:00.000Z" }),
  });
  const r = await handle(SF_REQ, TOKEN, deps);
  assertEquals(r.status, 403);
});

Deno.test("action storefront: không shop + custom data trống → need_shop, không gọi MCP", async () => {
  let called = false;
  const { deps } = sfDeps(fakeMcp({
    findStore: () => {
      called = true;
      return Promise.reject(new Error("không được gọi"));
    },
  }));
  const { shop: _omit, ...noShopReq } = SF_REQ;
  const r = await handle(noShopReq, TOKEN, deps);
  assertEquals(r.status, 200);
  const body = r.body as { status: string; store: string | null };
  assertEquals(body.status, "need_shop");
  assertEquals(body.store, null);
  assertEquals(called, false);
});

Deno.test("action storefront: shopify_domain trong custom data không hợp lệ (không phải string / có khoảng trắng) → need_shop, không 400", async () => {
  for (const bad of [123, "có khoảng trắng.com", "ab"]) {
    const { deps } = sfDeps(fakeMcp(), {
      getConversation: () => Promise.resolve({ ...CONV, custom_data: { shopify_domain: bad } }),
    });
    const { shop: _omit, ...noShopReq } = SF_REQ;
    const r = await handle(noShopReq, TOKEN, deps);
    assertEquals(r.status, 200, String(bad));
    assertEquals((r.body as { status: string }).status, "need_shop", String(bad));
  }
});

Deno.test("action storefront: 2 session khác nhau, gọi xen kẽ → mỗi session resolve đúng shopify_domain của mình, session không có custom_data → need_shop", async () => {
  // Fake DB khoá ĐÚNG theo (website_id, session_id) như createDb thật: fake
  // cũ trả một CONV cố định bất kể session nên không bắt được lẫn chéo — ở đây
  // mỗi session có domain riêng và lời gọi getConversation được ghi lại.
  const domains: Record<string, string> = {
    "ws1/session_1": "shop-one.myshopify.com",
    "ws1/session_2": "shop-two.myshopify.com",
  };
  const convCalls: [string, string][] = [];
  const shopsSeen: string[] = [];
  const { deps } = sfDeps(fakeMcp({
    findStore: (_w: string, shop: string) => {
      shopsSeen.push(shop);
      return Promise.resolve({ watched: true, shop, lastCheckedAt: "2026-10-23T07:00:00Z", openBySeverity: {}, uncheckedPages: [] });
    },
  }), {
    getConversation: (websiteId: string, sessionId: string) => {
      convCalls.push([websiteId, sessionId]);
      const domain = domains[`${websiteId}/${sessionId}`];
      return Promise.resolve({
        ...CONV,
        website_id: websiteId,
        session_id: sessionId,
        custom_data: domain ? { shopify_domain: domain } : {},
      });
    },
  });
  const reqFor = (session_id: string) => ({ website_id: "ws1", session_id, action: "storefront" });
  const r1 = await handle(reqFor("session_1"), TOKEN, deps);
  const r2 = await handle(reqFor("session_2"), TOKEN, deps);
  const r1b = await handle(reqFor("session_1"), TOKEN, deps); // quay lại session 1: không được dính domain của session 2
  assertEquals((r1.body as { store: string | null }).store, "shop-one.myshopify.com");
  assertEquals((r2.body as { store: string | null }).store, "shop-two.myshopify.com");
  assertEquals((r1b.body as { store: string | null }).store, "shop-one.myshopify.com");
  assertEquals(shopsSeen, ["shop-one.myshopify.com", "shop-two.myshopify.com", "shop-one.myshopify.com"]);
  assertEquals(convCalls, [["ws1", "session_1"], ["ws1", "session_2"], ["ws1", "session_1"]]);
  // Session thứ ba không có custom_data: need_shop và MCP không bị gọi thêm.
  const r3 = await handle(reqFor("session_3"), TOKEN, deps);
  assertEquals(r3.status, 200);
  assertEquals((r3.body as { status: string }).status, "need_shop");
  assertEquals(shopsSeen.length, 3);
});

Deno.test("action storefront: cùng session_id nhưng khác website_id → resolve theo khoá kép, không dùng chung domain", async () => {
  const domains: Record<string, string> = {
    "ws1/session_1": "ws-one.myshopify.com",
    "ws2/session_1": "ws-two.myshopify.com",
  };
  const shopsSeen: string[] = [];
  const { deps } = sfDeps(fakeMcp({
    findStore: (_w: string, shop: string) => {
      shopsSeen.push(shop);
      return Promise.resolve({ watched: true, shop, lastCheckedAt: null, openBySeverity: {}, uncheckedPages: [] });
    },
  }), {
    getConversation: (websiteId: string, sessionId: string) =>
      Promise.resolve({
        ...CONV,
        website_id: websiteId,
        session_id: sessionId,
        custom_data: { shopify_domain: domains[`${websiteId}/${sessionId}`] },
      }),
  });
  const a = await handle({ website_id: "ws1", session_id: "session_1", action: "storefront" }, TOKEN, deps);
  const b = await handle({ website_id: "ws2", session_id: "session_1", action: "storefront" }, TOKEN, deps);
  assertEquals((a.body as { store: string | null }).store, "ws-one.myshopify.com");
  assertEquals((b.body as { store: string | null }).store, "ws-two.myshopify.com");
  assertEquals(shopsSeen, ["ws-one.myshopify.com", "ws-two.myshopify.com"]);
});

Deno.test("action storefront_finding: fingerprint sai định dạng → 400; thuộc store của conversation → trả chi tiết", async () => {
  const { deps } = sfDeps(fakeMcp({
    listFindings: () => Promise.resolve([finding(FP_A), finding(FP_B)]),
  }), {
    getConversation: () => Promise.resolve({ ...CONV, custom_data: { shopify_domain: "resolved.myshopify.com" } }),
  });
  const bad = await handle({ website_id: "ws1", session_id: "session_1", action: "storefront_finding", fingerprint: "xyz" }, TOKEN, deps);
  assertEquals(bad.status, 400);
  const ok = await handle({ website_id: "ws1", session_id: "session_1", action: "storefront_finding", fingerprint: FP_A }, TOKEN, deps);
  assertEquals(ok.status, 200);
  const body = ok.body as { status: string; detail: { consoleLink: string | null; judgement: string | null } | null };
  assertEquals(body.status, "ok");
  assertEquals(body.detail?.consoleLink, "https://sw.transcy.io/console/1");
  assertEquals(body.detail?.judgement, "judge thấy chồng chữ");
});

Deno.test("action storefront_finding: fingerprint của STORE KHÁC → từ chối, không gọi get_finding", async () => {
  // get_finding của SW tra toàn cục theo fingerprint — không đối chiếu với
  // store của conversation thì chat nào có cổng cũng xem được finding của
  // store khác (lẫn dữ liệu giữa các store, rà soát 2026-10-23).
  let getCalls = 0;
  const { deps } = sfDeps(fakeMcp({
    listFindings: () => Promise.resolve([finding(FP_B)]), // store của chat chỉ có FP_B
    getFinding: () => (getCalls++, Promise.reject(new Error("không được gọi"))),
  }), {
    getConversation: () => Promise.resolve({ ...CONV, custom_data: { shopify_domain: "resolved.myshopify.com" } }),
  });
  const r = await handle({ website_id: "ws1", session_id: "session_1", action: "storefront_finding", fingerprint: FP_A }, TOKEN, deps);
  assertEquals(r.status, 200);
  const body = r.body as { status: string; error: string | null; detail: unknown };
  assertEquals(body.status, "error");
  assertStringIncludes(body.error ?? "", "không thuộc store");
  assertEquals(body.detail, null);
  assertEquals(getCalls, 0);
});

Deno.test("action storefront_finding: conversation không có shopify_domain → error rõ, không gọi MCP", async () => {
  let called = false;
  const { deps } = sfDeps(fakeMcp({
    listFindings: () => (called = true, Promise.resolve([])),
  }));
  const r = await handle({ website_id: "ws1", session_id: "session_1", action: "storefront_finding", fingerprint: FP_A }, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals((r.body as { status: string }).status, "error");
  assertEquals(called, false);
});

// ---------- cổng domain (workspace Transcy, Ethan duyệt 2026-10-23) ----------

Deno.test("action storefront: KHÔNG có ticket TNT nhưng chat có shopify_domain (workspace Transcy) → qua cổng theo domain, 200", async () => {
  const { deps } = sfDeps(fakeMcp(), {
    getJiraRows: () => Promise.resolve([]), // không ticket nào liên kết
    getConversation: () => Promise.resolve({ ...CONV, custom_data: { shopify_domain: "shop-x.myshopify.com" } }),
  });
  const r = await handle(SF_REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals((r.body as { status: string }).status, "ok");
});

Deno.test("action storefront: bản chụp nói SW không theo dõi domain + không ticket → cổng VẪN mở, SW trực tiếp quyết (fake SW nói đang theo dõi → ok)", async () => {
  // Hồi quy ca live 2026-10-26: bản chụp sweep cũ/phủ quyết nhầm khiến store
  // có bug thật không hiện trên panel. Ethan chốt: có shopify_domain + cờ
  // workspace là qua cổng; watched hay không do lần gọi SW trực tiếp quyết.
  const { deps } = sfDeps(fakeMcp(), {
    getJiraRows: () => Promise.resolve([]),
    getConversation: () => Promise.resolve({ ...CONV, custom_data: { shopify_domain: "shop-x.myshopify.com" } }),
    getStorefrontStoreStatus: () => Promise.resolve({
      website_id: "ws1", shop: "shop-x.myshopify.com", watched: false,
      open_critical: 0, open_high: 0, open_medium: 0, open_low: 0, open_total: 0,
      worst_severity: null, last_good_check: null, fetched_at: "2026-10-23T00:00:00.000Z",
    }),
  });
  const r = await handle(SF_REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals((r.body as { status: string }).status, "ok");
});

Deno.test("action storefront: workspace OE (jira_project = OES, cờ storefront_watch TẮT) + có shopify_domain + không ticket → vẫn 403, cổng domain không mở ngoài phạm vi SW", async () => {
  const made = makeDeps({
    db: {
      getWorkspace: () => Promise.resolve({ ...WS, jira_project: "OES" }),
      getJiraRows: () => Promise.resolve([]),
      getConversation: () => Promise.resolve({ ...CONV, custom_data: { shopify_domain: "shop-x.myshopify.com" } }),
    },
  });
  const r = await handle(SF_REQ, TOKEN, { ...made.deps, storefront: fakeMcp() });
  assertEquals(r.status, 403);
});

Deno.test("action storefront: item trả về mang đủ kind/locale/page/consoleLink để widget gom nhóm + deep-link", async () => {
  const link = "https://sw.transcy.io/#/f/" + FP_A;
  const { deps } = sfDeps(fakeMcp({
    listFindings: () => Promise.resolve([
      finding(FP_A, { kind: "Region missing", title: "Region missing", locale: "ja", page: "/", severity: "critical", text: null, consoleLink: link }),
    ]),
  }));
  const r = await handle(SF_REQ, TOKEN, deps);
  const body = r.body as { groups: { new: Record<string, unknown>[] } };
  assertEquals(body.groups.new.length, 1);
  const item = body.groups.new[0];
  assertEquals(item.kind, "Region missing");
  assertEquals(item.locale, "ja");
  assertEquals(item.page, "/");
  assertEquals(item.severity, "critical");
  assertEquals(item.consoleLink, link);
});

// ---------- bản chụp trạng thái store (storeStatusFromStore) ----------

Deno.test("storeStatusFromStore: store có theo dõi — counts theo severity, worst = mức nặng nhất còn lỗi, shop là domain đã truy vấn", () => {
  const row = storeStatusFromStore("ws1", "queried.myshopify.com", {
    watched: true, shop: "canonical-khac.myshopify.com", lastCheckedAt: "2026-10-22",
    openBySeverity: { critical: 3, high: 6, medium: 0, low: 0 }, uncheckedPages: [],
  }, "2026-10-23T01:00:00.000Z");
  assertEquals(row, {
    website_id: "ws1", shop: "queried.myshopify.com", watched: true,
    open_critical: 3, open_high: 6, open_medium: 0, open_low: 0, open_total: 9,
    worst_severity: "critical", last_good_check: "2026-10-22", fetched_at: "2026-10-23T01:00:00.000Z",
  });
});

Deno.test("storeStatusFromStore: không theo dõi → mọi count 0, worst null; theo dõi mà 0 lỗi → worst null, open_total 0", () => {
  const notWatched = storeStatusFromStore("ws1", "x.myshopify.com", {
    watched: false, shop: "x.myshopify.com", lastCheckedAt: null, openBySeverity: {}, uncheckedPages: [],
  }, "2026-10-23T01:00:00.000Z");
  assertEquals([notWatched.watched, notWatched.open_total, notWatched.worst_severity, notWatched.last_good_check], [false, 0, null, null]);
  const clean = storeStatusFromStore("ws1", "x.myshopify.com", {
    watched: true, shop: "x.myshopify.com", lastCheckedAt: "2026-10-22",
    openBySeverity: { critical: 0, high: 0, medium: 0, low: 2 }, uncheckedPages: [],
  }, "2026-10-23T01:00:00.000Z");
  assertEquals([clean.open_total, clean.worst_severity], [2, "low"]);
});

// ---------- job đối chiếu nền (storefront_sweep) ----------

const SWEEP_NOW = Date.parse("2026-10-23T02:00:00.000Z");

function sweepHarness(
  domains: string[],
  storeByShop: Record<string, StorefrontStore | Error>,
  wsOver: Record<string, unknown> = {},
  mcp: StorefrontMcp | null = null,
) {
  const rows = new Map<string, StorefrontStoreStatus>();
  const findCalls: string[] = [];
  const made = makeDeps({
    db: {
      getWorkspace: () => Promise.resolve({ ...WS, jira_project: "TNT", storefront_watch: true, ...wsOver }),
      getRecentShopDomains: () => Promise.resolve(domains),
      upsertStorefrontStoreStatus: (row: StorefrontStoreStatus) => {
        rows.set(`${row.website_id}|${row.shop}`, { ...row });
        return Promise.resolve();
      },
    },
  });
  const client = mcp ?? fakeMcp({
    findStore: (_w: string, shop: string) => {
      findCalls.push(shop);
      const s = storeByShop[shop];
      if (s instanceof Error) return Promise.reject(s);
      return Promise.resolve(s ?? { watched: false, shop, lastCheckedAt: null, openBySeverity: {}, uncheckedPages: [] });
    },
  });
  return { deps: { db: made.deps.db, storefront: client, now: () => SWEEP_NOW }, rows, findCalls };
}

const STORE_OK: StorefrontStore = {
  watched: true, shop: "a.myshopify.com", lastCheckedAt: "2026-10-22",
  openBySeverity: { critical: 1, high: 0, medium: 2, low: 0 }, uncheckedPages: [],
};

Deno.test("sweep: quét đúng tập domain của workspace, upsert bản chụp kèm counts/worst khớp find_store", async () => {
  const h = sweepHarness(["a.myshopify.com", "b.myshopify.com"], { "a.myshopify.com": STORE_OK });
  const r = await runStorefrontSweep(h.deps, "ws1");
  assertEquals(r, { checked: 2, watched: 1, with_problems: 1, failed: 0, skipped: null });
  assertEquals(h.findCalls, ["a.myshopify.com", "b.myshopify.com"]);
  const a = h.rows.get("ws1|a.myshopify.com");
  assertEquals(a && [a.watched, a.open_total, a.worst_severity, a.last_good_check], [true, 3, "critical", "2026-10-22"]);
  const b = h.rows.get("ws1|b.myshopify.com");
  assertEquals(b && [b.watched, b.open_total], [false, 0]);
});

Deno.test("sweep: chạy lại 2 lần → bản chụp y hệt (idempotent, không nhân dòng, không cộng dồn)", async () => {
  const h = sweepHarness(["a.myshopify.com"], { "a.myshopify.com": STORE_OK });
  await runStorefrontSweep(h.deps, "ws1");
  const first = [...h.rows.values()];
  await runStorefrontSweep(h.deps, "ws1");
  assertEquals(h.rows.size, 1);
  assertEquals([...h.rows.values()], first);
});

Deno.test("sweep: workspace OE (jira_project = OES, cờ storefront_watch TẮT) → bỏ qua, không gọi SW, không quét domain của workspace đó", async () => {
  // Khoá hồi quy lỗi định danh cũ: OE cũng có jira_project (OES) — trước đây
  // sweep quét cả domain của OE. Nay chỉ cờ storefront_watch quyết phạm vi.
  const h = sweepHarness(["a.myshopify.com"], { "a.myshopify.com": STORE_OK }, { jira_project: "OES", storefront_watch: false });
  const r = await runStorefrontSweep(h.deps, "ws1");
  assertEquals(r.skipped, "not_transcy_workspace");
  assertEquals(h.findCalls, []);
  assertEquals(h.rows.size, 0);
});

Deno.test("sweep: jira_project = TNT nhưng cờ storefront_watch TẮT → vẫn bỏ qua (cờ là định danh duy nhất, không suy từ jira_project)", async () => {
  const h = sweepHarness(["a.myshopify.com"], { "a.myshopify.com": STORE_OK }, { storefront_watch: false });
  const r = await runStorefrontSweep(h.deps, "ws1");
  assertEquals(r.skipped, "not_transcy_workspace");
  assertEquals(h.findCalls, []);
  assertEquals(h.rows.size, 0);
});

Deno.test("sweep: một domain lỗi MCP → tính failed, các domain còn lại vẫn được chụp; chưa cấu hình MCP → skipped unconfigured", async () => {
  const h = sweepHarness(["bad.myshopify.com", "a.myshopify.com"], {
    "bad.myshopify.com": new StorefrontError("SW trả HTTP 503"),
    "a.myshopify.com": STORE_OK,
  });
  const r = await runStorefrontSweep(h.deps, "ws1");
  assertEquals([r.checked, r.failed, r.watched], [2, 1, 1]);
  assertEquals(h.rows.has("ws1|a.myshopify.com"), true);
  assertEquals(h.rows.has("ws1|bad.myshopify.com"), false); // lỗi thì giữ bản chụp cũ (không ghi đè bằng dữ kiện rỗng)

  const h2 = sweepHarness(["a.myshopify.com"], {}, {}, null);
  const r2 = await handleStorefrontSweep({ website_id: "ws1" }, { db: h2.deps.db, storefront: null });
  assertEquals(r2.status, 200);
  assertEquals((r2.body as { skipped: string | null }).skipped, "unconfigured");
});

Deno.test("parseFindingsText: store sạch (0 lỗi) trả [] thay vì văng lỗi định dạng; header biến thể không '(s)' vẫn đọc", () => {
  assertEquals(parseFindingsText("No open problems on tantaly-de.myshopify.com."), []);
  const one = `1 open problems on amirobeauty.com, worst first:
1. CRITICAL · Region missing · ja / (1440px)
   Seen 2 time(s), first 2026-10-14, last 2026-10-22
   Fingerprint: aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7
   Console: https://sw.transcy.io/#/f/aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7`;
  assertEquals(parseFindingsText(one).length, 1);
});

Deno.test("parseFindingsText: header 'The first N open problem(s)' (SW cắt trang khi quá 25 lỗi — ca live tantaly 2026-10-26) vẫn đọc", () => {
  const one = `The first 1 open problem(s) on www.tantaly.de, worst first:
1. HIGH · Graphic lost · nl /products/nesty-taschenmuschi (1440px)
   Seen 1 time(s), first 2026-10-22, last 2026-10-22
   Fingerprint: aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7
   Console: https://sw.transcy.io/#/f/aac0e074c62c1fe5906b5226eebb8f9cb1cc96b7`;
  const out = parseFindingsText(one);
  assertEquals(out.length, 1);
  assertEquals(out[0].kind, "Graphic lost");
});

Deno.test("parseFindingsText: dòng chốt 'The console lists the rest.' sau danh sách cắt trang được bỏ qua (ca live tantaly 2026-10-26)", () => {
  const block = (n: number) => `${n}. MEDIUM · Layout degraded · de / (1920px)
   Seen 2 time(s), first 2026-10-20, last 2026-10-22
   Fingerprint: ${String(n).padStart(40, "b")}
   Console: https://sw.transcy.io/#/f/${String(n).padStart(40, "b")}`;
  const text = `The first 2 open problem(s) on www.tantaly.de, worst first:
${block(1)}
${block(2)}
The console lists the rest.`;
  assertEquals(parseFindingsText(text).length, 2);
});

Deno.test("parseFindingsText: định dạng lạ → lỗi kèm đầu nội dung thật để truy được SW trả gì", () => {
  let msg = "";
  try { parseFindingsText("Invalid shop identifier: tantaly_de@myshopify.com"); } catch (e) { msg = (e as Error).message; }
  assertEquals(msg.includes("Invalid shop identifier"), true);
});
