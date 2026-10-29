// Client MCP tối thiểu cho Storefront Watch (https://sw-api.transcy.io/mcp),
// gọi TRỰC TIẾP từ Edge Function của copilot — không qua MCP server của Crisp,
// không qua Hugo (Ethan chốt cứng 2026-10-23). SW gác cổng /mcp bằng Bearer
// token + chữ ký HMAC theo spec Crisp công bố cho client MCP (Hugo → MCP API,
// docs.crisp.chat/guides/hugo/mcp-api/request-signing): SW theo spec đó vì
// Hugo là client đầu tiên của họ. Đã kiểm chứng gọi thật (2026-10-23):
// initialize + tools/list đều 200 khi ký đúng; thiếu chữ ký → 401.
//
// Chữ ký: HMAC-SHA256(secret, "{timestamp}.{website_id}.{raw_body}"), hex
// thường, header X-Crisp-Signature: "sha256=<hex>", kèm X-Crisp-Website-Id và
// X-Crisp-Timestamp (unix giây). Body ký phải là ĐÚNG chuỗi byte gửi đi.
//
// Secrets lấy từ env của function: SW_API_TOKEN (Bearer) + SW_MCP_SIGNING_SECRET
// (khoá ký). Thiếu một trong hai → storefrontFromEnv trả null và action trả
// trạng thái "unconfigured" — không gọi bừa bằng credential nửa vời.

import { neutralize } from "./prompts.ts";

export const SW_MCP_URL = "https://sw-api.transcy.io/mcp";
export const SW_TIMEOUT_MS = 15_000;

export class StorefrontError extends Error {}

/** HMAC-SHA256 hex thường của payload — hàm thuần để test bằng known vector. */
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Giá trị header X-Crisp-Signature cho một request: ký "{ts}.{websiteId}.{rawBody}". */
export async function swSignature(secret: string, timestamp: string, websiteId: string, rawBody: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, `${timestamp}.${websiteId}.${rawBody}`)}`;
}

export interface StorefrontStore {
  watched: boolean;
  shop: string | null;
  lastCheckedAt: string | null;
  openBySeverity: Record<string, number>;
  uncheckedPages: string[];
  /** Ngôn ngữ store được quét (dòng "Languages:" của find_store). */
  languages?: string[];
  /** Số trang đã quét (cùng dòng "Languages: … · pages: N"). */
  pagesChecked?: number | null;
}

export interface StorefrontFinding {
  fingerprint: string;
  title: string;
  meta: string;
  severity: string | null;
  locale: string | null;
  /** Đường dẫn/URL trang chứa lỗi — một "kim" để khớp hội thoại (Đang xử lý). */
  page: string | null;
  /** Đoạn text trong vùng bị lỗi — "kim" thứ hai để khớp hội thoại. */
  text: string | null;
  /** Loại lỗi phía SW (vd "Region missing") — cũng là title hiển thị. */
  kind?: string | null;
  /** Bề rộng viewport lúc quét, px (đuôi "(1440px)"). */
  widthPx?: number | null;
  /** Số lần SW đã thấy lỗi này + mốc thấy đầu/gần nhất (dòng "Seen …"). */
  seenCount?: number | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  /** Từng đoạn text trong vùng lỗi (dòng Text: có thể nhiều chuỗi ngoặc kép). text = các đoạn nối ", ". */
  texts?: string[];
  consoleLink?: string | null;
  /** Dòng trạng thái phía SW trong list_findings nếu có (vd "acknowledged") — nguyên văn thường hoá; vắng = SW không ghi trạng thái trong danh sách. */
  swState?: string | null;
}

export interface StorefrontFindingDetail extends StorefrontFinding {
  where: string | null;
  judgement: string | null;
  dismissed: boolean;
  fixed: boolean;
  /** SW đã ghi nhận có người đang xử lý (State: acknowledged / in progress) — qua tool acknowledge_finding. */
  acknowledged: boolean;
  consoleLink: string | null;
  /** Trạng thái thô phía SW (dòng "State:"): "open" | "dismissed" | "fixed" | … — list_findings chỉ liệt kê open, get_finding mới thấy các trạng thái đóng. */
  state?: string | null;
  /** Loại lỗi phụ (đuôi "(also …)" ở dòng severity của get_finding). */
  alsoKinds?: string[];
}

export interface StorefrontMcp {
  findStore(websiteId: string, shop: string): Promise<StorefrontStore>;
  listFindings(websiteId: string, shop: string): Promise<StorefrontFinding[]>;
  getFinding(websiteId: string, fingerprint: string): Promise<StorefrontFindingDetail>;
  /**
   * 4 tool GHI phía SW mở scope ngày 2026-10-27 (kiểm chứng live bằng
   * tools/list: acknowledge_finding / mark_fixed / dismiss_finding / undo —
   * cả 4 readOnlyHint: false). Đây là ngoại lệ CÓ KIỂM SOÁT của nguyên tắc
   * "panel chỉ đọc, đổi trạng thái trong Console" (Ethan chốt lại 2026-10-27
   * khi duyệt menu thao tác): ghi CHỈ xảy ra khi CS bấm nút trong panel qua
   * action storefront_act, không có đường ghi tự động nào. Mỗi hàm trả text
   * xác nhận của tool (có thể rỗng); lỗi tool → StorefrontError như đường đọc.
   */
  acknowledgeFinding(websiteId: string, fingerprint: string, operator?: string): Promise<string>;
  markFixed(websiteId: string, fingerprint: string, note: string, operator?: string): Promise<string>;
  dismissFinding(websiteId: string, fingerprint: string, reason: string, note: string, operator?: string): Promise<string>;
  undoFinding(websiteId: string, fingerprint: string): Promise<string>;
}

/** Lý do dismiss phía SW nhận (inputSchema của dismiss_finding, kiểm chứng live 2026-10-27). */
export const SW_DISMISS_REASONS = ["false_signal", "not_important"] as const;
export type SwDismissReason = typeof SW_DISMISS_REASONS[number];

/**
 * Bản chụp trạng thái một store (bảng storefront_store_status, migration
 * 022): job đối chiếu nền ghi sau mỗi lần gọi find_store, check đọc để quyết
 * cổng Storefront + hiện badge số lỗi mở mà không phải gọi MCP lúc mở panel.
 */
export interface StorefrontStoreStatus {
  website_id: string;
  shop: string;
  watched: boolean;
  open_critical: number;
  open_high: number;
  open_medium: number;
  open_low: number;
  open_total: number;
  /** Mức nặng nhất còn lỗi mở: critical > high > medium > low; null khi không còn lỗi nào / store chưa được theo dõi. */
  worst_severity: string | null;
  /** Ngày SW quét tốt gần nhất (nguyên văn dòng "Last good check:" của find_store, dạng YYYY-MM-DD). */
  last_good_check: string | null;
  fetched_at: string;
}

export const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

/**
 * Dựng một dòng bản chụp từ kết quả find_store (hàm thuần — job sweep dùng,
 * test khoá độc lập với DB). shop là DOMAIN ĐÃ TRUY VẤN (lấy từ custom_data),
 * không lấy store.shop do SW trả: check tra bản chụp bằng đúng domain trong
 * custom_data của conversation, hai phía phải dùng cùng một khoá.
 */
export function storeStatusFromStore(websiteId: string, queriedShop: string, store: StorefrontStore, fetchedAt: string): StorefrontStoreStatus {
  const count = (k: string) => Math.max(0, Math.floor(store.openBySeverity?.[k] ?? 0) || 0);
  const [critical, high, medium, low] = SEVERITY_ORDER.map(count);
  const open_total = store.watched ? critical + high + medium + low : 0;
  const worst = !store.watched || open_total === 0
    ? null
    : SEVERITY_ORDER.find((k) => count(k) > 0) ?? null;
  return {
    website_id: websiteId,
    shop: queriedShop,
    watched: store.watched,
    open_critical: store.watched ? critical : 0,
    open_high: store.watched ? high : 0,
    open_medium: store.watched ? medium : 0,
    open_low: store.watched ? low : 0,
    open_total,
    worst_severity: worst,
    last_good_check: store.watched ? store.lastCheckedAt : null,
    fetched_at: fetchedAt,
  };
}

/**
 * Kiểm hợp lệ tối thiểu cho một giá trị shop lấy từ dữ liệu phía khách ghi
 * (custom_data.shopify_domain): domain/link của store, 3–300 ký tự, không
 * khoảng trắng, không ký tự phá vỡ HTML/thuộc tính. Dữ liệu khách ghi được
 * nên mọi nơi dùng giá trị này đều phải qua đây trước khi gọi MCP/hiển thị.
 */
export function isPlausibleShop(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 3 && v.trim().length <= 300 && !/[\s<>"']/.test(v.trim());
}

// ---------- parse output của tool (prose có cấu trúc cố định) ----------
// Cả 3 tool trả TEXT PROSE theo mẫu cố định — đã bắt mẫu thật 2026-10-23 từ
// hai store đang được theo dõi (amirobeauty.com: find_store + 9 findings,
// iglow.me: 5 findings, cộng get_finding của 2 fingerprint). KHÔNG có JSON:
// lớp đoán field kiểu cũ đọc không được gì. Mẫu đã kiểm chứng:
//
//   find_store (có theo dõi):
//     Store: amirobeauty.com
//     In the weekly sweep: yes
//     Languages: es, ja, zh · pages: 31
//     Last good check: 2026-10-22
//     Open problems: 3 critical, 6 high, 0 medium, 0 low
//   find_store (không theo dõi):
//     Store: X
//     Storefront Watch does not watch this store and has never scanned it.
//     That means nothing is known about it, not that it has no problems.
//   find_store (có theo dõi, chưa quét thành công trang nào — mẫu thật
//   2026-10-28, dev.bouwmaat.nl):
//     Store: dev.bouwmaat.nl (asked as bouwmaat-dev.myshopify.com)
//     In the weekly sweep: yes
//     Languages: de, en, pl, tr · pages: 4
//     Last good check: none yet
//     Open problems: unknown, no page has been checked successfully yet
//     Not checked, so unknown (not clean): 4 page(s)
//     - de /: the language could not be confirmed (inconclusive)
//   find_store (domain không tới được, SW không giữ gì — mẫu thật
//   2026-10-28, 5f5291-40.myshopify.com):
//     Store: 5f5291-40.myshopify.com
//     Storefront Watch could not reach 5f5291-40.myshopify.com to find its
//     main domain (HTTP 404), and holds nothing under that name.
//   list_findings (chưa quét thành công — mẫu thật 2026-10-28):
//     Problems on dev.bouwmaat.nl are unknown: no page has been checked
//     successfully yet.
//     4 page(s) could not be checked, so this list may be incomplete.
//   list_findings:
//     9 open problem(s) on amirobeauty.com, worst first:
//     1. CRITICAL · Region missing · ja / (1440px)
//        Seen 2 time(s), first 2026-10-14, last 2026-10-22
//        Fingerprint: <40 hex>
//        Console: https://sw.transcy.io/#/f/<fingerprint>
//     4. HIGH · Option unidentifiable · zh /products/… (1440px)
//        Seen 1 time(s), first 2026-10-22, last 2026-10-22
//        Text: "Color"            (tuỳ chọn; nhiều đoạn: "Rosa", "Blanco")
//        Fingerprint: …
//        Console: …
//   get_finding:
//     Finding <40 hex>
//     HIGH · Option unidentifiable (also Graphic lost)
//     Where: amirobeauty.com · zh · /products/… · 1440px wide
//     State: open
//     Seen 1 time(s), first 2026-10-22, last 2026-10-22
//     Judge: confirmed, "<mô tả dài>"   (hoặc mã ngắn, vd "no_crops"; tuỳ chọn)
//     Text in the broken area: "Color"  (tuỳ chọn)
//     Console: https://sw.transcy.io/#/f/<fingerprint>
//
// Parse không khớp mẫu → StorefrontError trung thực, KHÔNG bịa dữ liệu.

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Rec : {};
}

const NOT_WATCHED_MARK = "does not watch this store";
// Mẫu thật 2026-10-28: domain SW không với tới được / không giữ dữ liệu gì —
// cùng nghĩa "không biết gì" với NOT_WATCHED_MARK nhưng khác câu chữ.
const UNREACHABLE_MARK = "holds nothing under that name";
// Mẫu thật 2026-10-28: store ĐƯỢC theo dõi nhưng chưa trang nào quét thành
// công — xuất hiện ở cả find_store ("Open problems: unknown, …") lẫn
// list_findings ("Problems on X are unknown: …").
const UNKNOWN_PROBLEMS_MARK = "no page has been checked successfully yet";
const SEEN_RE = /^Seen (\d+) time\(s\), first (\d{4}-\d{2}-\d{2}), last (\d{4}-\d{2}-\d{2})$/;
const FINGERPRINT_RE = /^[0-9a-f]{40}$/;

function textLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** Trích các chuỗi trong ngoặc kép: `"Rosa", "Blanco"` → ["Rosa", "Blanco"]. */
function quotedStrings(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

function baseFinding(parts: {
  fingerprint: string;
  severity: string | null;
  kind: string | null;
  locale: string | null;
  page: string | null;
  texts: string[];
}): StorefrontFinding {
  const title = parts.kind ?? parts.page ?? "Lỗi bố cục bản dịch";
  const meta = [parts.severity, parts.locale, parts.page && parts.page !== title ? parts.page : null]
    .filter(Boolean).join(" · ");
  return {
    fingerprint: parts.fingerprint,
    title,
    meta,
    severity: parts.severity,
    locale: parts.locale,
    page: parts.page,
    text: parts.texts.length ? parts.texts.join(", ") : null,
    kind: parts.kind,
    texts: parts.texts,
  };
}

function parseSeenLine(line: string): { seenCount: number; firstSeenAt: string; lastSeenAt: string } | null {
  const m = line.match(SEEN_RE);
  if (!m) return null;
  return { seenCount: Number(m[1]), firstSeenAt: m[2], lastSeenAt: m[3] };
}

export function parseStoreText(text: string, shopArg: string): StorefrontStore {
  const lines = textLines(text);
  const storeLine = lines.find((l) => l.startsWith("Store: "));
  if (!storeLine) throw new StorefrontError("find_store trả định dạng lạ (thiếu dòng 'Store:'), không đọc được");
  // SW chú thích "(asked as <domain khác>)" sau tên store khi domain được hỏi
  // khác domain chuẩn của store — đó là ghi chú hiển thị, KHÔNG thuộc định
  // danh store. Không lột thì chú thích (kèm domain Shopify) lọt vào mọi nơi
  // dùng shop làm khoá, tệ nhất là URL Console thành link chết (Ethan bắt
  // live 2026-10-27 trên ca tantaly).
  const shop = storeLine.slice("Store: ".length).trim()
    .replace(/\s*\(asked as [^)]*\)$/, "").trim() || shopArg;
  if (text.includes(NOT_WATCHED_MARK) || text.includes(UNREACHABLE_MARK)) {
    return { watched: false, shop, lastCheckedAt: null, openBySeverity: {}, uncheckedPages: [], languages: [], pagesChecked: null };
  }
  const openLine = lines.find((l) => l.startsWith("Open problems: "));
  if (!openLine) throw new StorefrontError("find_store trả định dạng lạ (thiếu dòng 'Open problems:'), không đọc được");
  // Store được theo dõi nhưng CHƯA trang nào quét thành công (mẫu thật
  // 2026-10-28, dev.bouwmaat.nl + united-arrows-global.com): dòng Open
  // problems ghi "unknown, no page has been checked successfully yet" —
  // không có số đếm nào để đọc, và đó là SỰ THẬT (chưa biết), không phải
  // định dạng lạ. Trả counts rỗng; tính "chưa biết" được phân biệt với store
  // sạch nhờ lastCheckedAt null + uncheckedPages bên dưới.
  const problemsUnknown = openLine.includes(UNKNOWN_PROBLEMS_MARK);
  const openBySeverity: Record<string, number> = {};
  if (!problemsUnknown) {
    for (const m of openLine.matchAll(/(\d+)\s+(critical|high|medium|low)\b/g)) openBySeverity[m[2]] = Number(m[1]);
    if (!Object.keys(openBySeverity).length) {
      throw new StorefrontError("find_store trả định dạng lạ (dòng 'Open problems:' không có số đếm), không đọc được");
    }
  }
  let languages: string[] = [];
  let pagesChecked: number | null = null;
  const langLine = lines.find((l) => l.startsWith("Languages: "));
  if (langLine) {
    const rest = langLine.slice("Languages: ".length);
    const [langs, pages] = rest.split(" · ");
    languages = (langs ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const pm = (pages ?? "").match(/pages:\s*(\d+)/);
    if (pm) pagesChecked = Number(pm[1]);
  }
  const checkLine = lines.find((l) => l.startsWith("Last good check: "));
  const checkRaw = checkLine ? checkLine.slice("Last good check: ".length).trim() : null;
  // "none yet" = chưa từng có lần quét thành công → null như chưa có mốc
  // (giữ nguyên văn sẽ làm hỏng cột ngày ở storeStatusFromStore).
  const lastCheckedAt = checkRaw && checkRaw !== "none yet" ? checkRaw : null;
  // Khối trang chưa quét được — mẫu thật 2026-10-28: dòng "Not checked, so
  // unknown (not clean): N page(s)" rồi mỗi trang một dòng "- <nội dung>".
  const uncheckedPages: string[] = [];
  const ncIdx = lines.findIndex((l) => l.startsWith("Not checked, so unknown"));
  if (ncIdx >= 0) {
    for (const l of lines.slice(ncIdx + 1)) {
      if (l.startsWith("- ")) uncheckedPages.push(l.slice(2).trim());
      else if (l.trim()) break;
    }
  }
  return {
    watched: true,
    shop,
    lastCheckedAt,
    openBySeverity,
    uncheckedPages,
    languages,
    pagesChecked,
  };
}

const FINDING_HEAD_RE = /^(\S+)\s+·\s+(.+?)\s+·\s+(\S+)\s+(.+?)\s+\((\d+)px\)$/;

function parseListBlock(blockLines: string[]): StorefrontFinding {
  const head = blockLines[0].replace(/^\d+\.\s+/, "");
  const hm = head.match(FINDING_HEAD_RE);
  if (!hm) throw new StorefrontError(`list_findings trả dòng finding lạ, không đọc được: "${blockLines[0].trim()}"`);
  const [, severityRaw, kind, locale, page, width] = hm;
  let seen: ReturnType<typeof parseSeenLine> = null;
  let texts: string[] = [];
  let fingerprint: string | null = null;
  let consoleLink: string | null = null;
  let swState: string | null = null;
  for (const raw of blockLines.slice(1)) {
    const line = raw.trim();
    if (line.startsWith("Seen ")) seen = parseSeenLine(line);
    else if (line.startsWith("Text: ")) texts = quotedStrings(line.slice("Text: ".length));
    else if (line.startsWith("Fingerprint: ")) fingerprint = line.slice("Fingerprint: ".length).trim();
    else if (line.startsWith("Console: ")) consoleLink = line.slice("Console: ".length).trim();
    // Dòng trạng thái của finding ĐÃ được ghi nhận xử lý (từ khi SW mở tool
    // acknowledge_finding 2026-10-27): SW có thể ghi vào danh sách — nhận
    // biết và giữ lại thay vì văng lỗi làm hỏng cả panel của store đó. Mọi
    // dòng lạ KHÁC vẫn văng lỗi như cũ (hàng rào toàn vẹn là đối chiếu số
    // finding với header ở parseFindingsText).
    else if (/^(State|Acknowledged|In progress|Being handled)\b/i.test(line)) {
      swState = line.replace(/^State:\s*/i, "").trim().toLowerCase() || "acknowledged";
    }
    else if (line) throw new StorefrontError(`list_findings trả dòng lạ trong một finding: "${line}"`);
  }
  if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
    throw new StorefrontError("list_findings trả finding thiếu fingerprint hợp lệ, không đọc được");
  }
  // Link "Console:" SW in sẵn dùng mã fingerprint — Console thật KHÔNG mở
  // được dạng đó (báo "no audited unit", kiểm chứng live 2026-10-26). Panel
  // không dùng link in sẵn nữa; link đúng cấu từ khóa unit (hàm
  // consoleUnitUrl dưới đây). Giữ lại giá trị thô cho chi tiết/tương thích.
  const f = baseFinding({ fingerprint, severity: severityRaw.toLowerCase(), kind, locale, page, texts });
  f.widthPx = Number(width);
  if (seen) Object.assign(f, seen);
  f.consoleLink = consoleLink;
  f.swState = swState;
  return f;
}

/**
 * URL finding ĐÚNG của Console (kiểm chứng live 2026-10-26 bằng cách đăng
 * nhập lướt Console): #/f/<domain>|<locale>|<page>|<width> với | và / được
 * mã hoá %7C/%2F — đúng khoá "audited unit" của Console. Thiếu một mảnh
 * (domain/locale/page/bề rộng) thì trả null: thà không có link còn hơn gắn
 * link chết cho CS bấm.
 */
/**
 * URL TRANG THẬT trên store mà SW quét thấy finding này (Ethan, 2026-10-29):
 * panel đặt nút "Xem trang lỗi" ngay cạnh từng finding để CS mở tab mới nhìn
 * tận mắt lỗi trên trang khách đang thấy, tách bạch với link Console (trang
 * quản trị SW). Cấu từ domain + page (path SW ghi trong finding, vd
 * "/products/abc"; trang chủ là "/"). Thiếu domain hợp lệ hoặc page không
 * phải path bắt đầu bằng "/" thì trả null: thà không có nút còn hơn gắn link
 * chết/đoán mò. Locale KHÔNG chắp vào URL: SW không cho biết store dùng tiền
 * tố ngôn ngữ kiểu nào (path prefix, subdomain hay query) — đoán sẽ sinh link
 * sai; trang đích vẫn là đúng trang có lỗi, ở ngôn ngữ mặc định của store.
 */
export function storefrontPageUrl(domain: string | null | undefined, f: { page?: string | null }): string | null {
  const clean = (domain ?? "").trim().replace(/\s*\(asked as [^)]*\)$/, "").trim();
  if (!clean || /[\s()]/.test(clean)) return null;
  const page = (f.page ?? "").trim();
  if (!page.startsWith("/") || /[\s<>"']/.test(page)) return null;
  return `https://${clean}${page}`;
}

/**
 * URL trang ở ĐÚNG locale mà SW đã quét thấy finding này (Ethan, 2026-10-29):
 * panel hiện 3 link thẳng hàng — "Default page" (storefrontPageUrl: trang ở
 * ngôn ngữ mặc định của store), "Issue page" (hàm này: chắp tiền tố locale
 * theo quy ước subfolder của Shopify, vd /en/products/… — đúng biến thể tool
 * đã audit), "Console" (consoleUnitUrl). Locale không phải mã ngôn ngữ hợp
 * lệ thì trả null; page đã chứa sẵn tiền tố locale thì trả luôn URL mặc
 * định (khỏi chắp trùng — panel tự ẩn link Issue khi trùng Default).
 */
export function storefrontIssuePageUrl(domain: string | null | undefined, f: { locale?: string | null; page?: string | null }): string | null {
  const base = storefrontPageUrl(domain, f);
  if (!base) return null;
  const locale = (f.locale ?? "").trim();
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,4})?$/.test(locale)) return null;
  const page = (f.page ?? "").trim();
  if (page === `/${locale}` || page.startsWith(`/${locale}/`)) return base;
  const clean = (domain ?? "").trim().replace(/\s*\(asked as [^)]*\)$/, "").trim();
  return `https://${clean}/${locale}${page}`;
}


export function consoleUnitUrl(domain: string | null | undefined, f: { locale?: string | null; page?: string | null; widthPx?: number | null }): string | null {
  // Chốt chặn tại chỗ cấu URL (parseStoreText đã lột ở nguồn): domain còn dính
  // chú thích "(asked as …)" thì lột; vẫn còn khoảng trắng/ngoặc (không thể là
  // một domain thật) thì thà trả null còn hơn gắn link chết.
  const clean = (domain ?? "").trim().replace(/\s*\(asked as [^)]*\)$/, "").trim();
  if (!clean || /[\s()]/.test(clean) || !f.locale || !f.page || !f.widthPx) return null;
  return `https://sw.transcy.io/#/f/${encodeURIComponent(`${clean}|${f.locale}|${f.page}|${f.widthPx}`)}`;
}

export function parseFindingsText(text: string): StorefrontFinding[] {
  if (text.includes(NOT_WATCHED_MARK)) return [];
  // Store chưa từng quét thành công trang nào (mẫu thật 2026-10-28): SW trả
  // "Problems on X are unknown: no page has been checked successfully yet." —
  // chưa BIẾT lỗi nào, khác "không có lỗi", nhưng với nơi dùng danh sách
  // finding thì cả hai đều là danh sách rỗng; tính "chưa biết" nằm ở
  // find_store (lastCheckedAt null + uncheckedPages), không lặp lại ở đây.
  if (text.includes(UNKNOWN_PROBLEMS_MARK)) return [];
  const lines = textLines(text);
  // Store đang theo dõi nhưng không còn lỗi mở: SW trả một dòng báo trống
  // thay cho khối danh sách — đó là kết quả HỢP LỆ (0 lỗi), không phải lỗi
  // định dạng (ca live 2026-10-26: parser cũ văng lỗi oan ở đúng ca này).
  if (lines.some((l) => /no open problems?\b/i.test(l))) return [];
  const headerIdx = lines.findIndex((l) => /^(?:the first\s+)?\d+ open problems?\b.*$/i.test(l));
  if (headerIdx < 0) {
    const head = lines.filter((l) => l.trim()).slice(0, 3).map((l) => l.trim().slice(0, 120)).join(" | ");
    throw new StorefrontError(`list_findings trả định dạng lạ (thiếu dòng mở đầu 'N open problem(s) …'), không đọc được. Đầu nội dung thật: ${head}`);
  }
  const declared = Number(lines[headerIdx].match(/(\d+)\s+open problem/i)![1]);
  const blocks: string[][] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    if (/^\d+\.\s+/.test(line)) blocks.push([line]);
    else if (/^\s/.test(line) && blocks.length) blocks[blocks.length - 1].push(line);
    // SW hay thêm câu chốt THÔNG TIN sau danh sách ("The console lists the
    // rest." khi cắt ở 25 lỗi đầu; "4 page(s) could not be checked, so this
    // list may be incomplete." — cả hai đều gặp live ở tantaly 2026-10-26).
    // Finding luôn đánh số nên câu văn xuôi sau khi đã có finding không thể
    // là finding: bỏ qua. Hàng rào toàn vẹn là đối chiếu số block với số
    // khai báo ở header ngay dưới đây — thiếu finding thật vẫn văng lỗi.
    else if (blocks.length) continue;
    else throw new StorefrontError(`list_findings trả dòng lạ ngoài finding: "${line.trim()}"`);
  }
  if (blocks.length !== declared) {
    throw new StorefrontError(`list_findings báo ${declared} problem nhưng đọc được ${blocks.length}, không khớp — không dùng dữ liệu này`);
  }
  return blocks.map(parseListBlock);
}

export function parseFindingDetailText(text: string): StorefrontFindingDetail {
  const lines = textLines(text);
  const first = (lines[0] ?? "").trim();
  const fm = first.match(/^Finding ([0-9a-f]{40})$/);
  if (!fm) throw new StorefrontError(`get_finding trả định dạng lạ (thiếu dòng 'Finding <fingerprint>'), không đọc được. Dòng đầu thật: ${first.slice(0, 120)}`);
  const fingerprint = fm[1];
  let severity: string | null = null;
  let kind: string | null = null;
  let alsoKinds: string[] = [];
  let where: string | null = null;
  let locale: string | null = null;
  let page: string | null = null;
  let widthPx: number | null = null;
  let state: string | null = null;
  let seen: ReturnType<typeof parseSeenLine> = null;
  let judgement: string | null = null;
  let texts: string[] = [];
  let consoleLink: string | null = null;
  let inJudge = false;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const isSeverityLine = severity === null && kind === null &&
      !/^(Where|State|Seen|Judge|Text|Console)[\s:]/.test(line);
    if (isSeverityLine) {
      const sevM = line.match(/^(\S+)\s+·\s+(.+)$/);
      if (!sevM) throw new StorefrontError(`get_finding trả dòng severity lạ: "${line}"`);
      severity = sevM[1].toLowerCase();
      const kindPart = sevM[2].match(/^(.*?)(?:\s+\(also (.+)\))?$/);
      kind = (kindPart?.[1] ?? sevM[2]).trim();
      alsoKinds = kindPart?.[2] ? kindPart[2].split(",").map((s: string) => s.trim()).filter(Boolean) : [];
      inJudge = false;
    } else if (line.startsWith("Where: ")) {
      where = line.slice("Where: ".length).trim();
      const parts = where.split(" · ");
      if (parts.length >= 3) {
        locale = parts[1] ?? null;
        const lastPart = parts[parts.length - 1];
        const wm = lastPart.match(/^(\d+)px wide$/);
        if (wm && parts.length >= 4) {
          widthPx = Number(wm[1]);
          page = parts.slice(2, -1).join(" · ") || null;
        } else {
          page = parts.slice(2).join(" · ") || null;
        }
      }
      inJudge = false;
    } else if (line.startsWith("State: ")) {
      state = line.slice("State: ".length).trim().toLowerCase();
      inJudge = false;
    } else if (line.startsWith("Seen ")) {
      seen = parseSeenLine(line);
      inJudge = false;
    } else if (line.startsWith("Judge: ")) {
      judgement = line.slice("Judge: ".length).trim();
      inJudge = true;
    } else if (line.startsWith("Text in the broken area: ")) {
      texts = quotedStrings(line.slice("Text in the broken area: ".length));
      inJudge = false;
    } else if (line.startsWith("Console: ")) {
      consoleLink = line.slice("Console: ".length).trim();
      inJudge = false;
    } else if (inJudge && judgement !== null) {
      // Judge mô tả dài có thể xuống dòng — phần tiếp nối thuộc về judgement
      // cho tới khi gặp một dòng có tiền tố đã biết.
      judgement += "\n" + line;
    } else {
      throw new StorefrontError(`get_finding trả dòng lạ: "${line}"`);
    }
  }
  if (consoleLink && !consoleLink.includes(fingerprint)) {
    throw new StorefrontError("get_finding trả Console không chứa fingerprint của finding, không đọc được");
  }
  const base = baseFinding({ fingerprint, severity, kind, locale, page, texts });
  base.widthPx = widthPx;
  if (seen) Object.assign(base, seen);
  return {
    ...base,
    where,
    judgement,
    dismissed: state === "dismissed",
    fixed: state === "fixed",
    acknowledged: state === "acknowledged" || state === "in_progress" || state === "in progress" || state === "in-progress",
    consoleLink,
    state,
    alsoKinds,
  };
}

// ---------- chia 3 trạng thái (mô hình Ethan chốt 2026-10-23) ----------

export type FindingGroup = "in_progress" | "new" | "acknowledged";

export interface GroupedFindings {
  new: StorefrontFinding[];
  acknowledged: StorefrontFinding[];
  in_progress: StorefrontFinding[];
}

/** Chuẩn hoá để so khớp: thường hoá + gộp khoảng trắng. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Các "kim" của một finding để tìm trong tin nhắn của CS: đường dẫn trang
 * (nguyên văn và riêng phần path nếu là URL đầy đủ) và đoạn text lỗi.
 * Kim quá ngắn (< 4 ký tự với path, < 8 với text) thì bỏ — khớp bừa còn tệ
 * hơn không khớp.
 */
export function findingNeedles(f: StorefrontFinding): string[] {
  const out = new Set<string>();
  if (f.page) {
    const p = norm(f.page);
    if (p.length >= 4) out.add(p);
    try {
      const path = norm(new URL(f.page).pathname);
      if (path.length >= 4) out.add(path);
    } catch { /* page không phải URL đầy đủ — dùng nguyên văn ở trên là đủ */ }
  }
  if (f.text) {
    const t = norm(f.text).slice(0, 80);
    if (t.length >= 8) out.add(t);
  }
  // Từng đoạn text riêng cũng là kim: CS nhắc một đoạn trong số nhiều đoạn
  // của vùng lỗi là đủ bằng chứng đã contact, không cần nhắc hết cả cụm.
  for (const t of f.texts ?? []) {
    const n = norm(t).slice(0, 80);
    if (n.length >= 8) out.add(n);
  }
  return [...out];
}

/** Finding được coi là Đang xử lý khi nội dung của nó xuất hiện trong tin CS đã gửi cho khách. */
export function mentionedInConversation(f: StorefrontFinding, operatorTexts: string[]): boolean {
  const needles = findingNeedles(f);
  if (!needles.length) return false;
  return operatorTexts.some((t) => {
    const hay = norm(t);
    return needles.some((n) => hay.includes(n));
  });
}

/**
 * Gom finding vào đúng 1 nhóm. Thứ tự ưu tiên (ghi rõ theo quyết định thiết kế):
 *   Đang xử lý (khớp hội thoại) > Mới (chưa từng hiện trên panel) > Đã xác nhận.
 * "Đã từng hiện" = fingerprint có trong storefront_seen của workspace
 * (watermark ở DB); caller phải đọc mốc TRƯỚC, gom nhóm xong mới ghi mốc mới —
 * ghi trước sẽ biến mọi finding thành Đã xác nhận.
 */
export function classifyFindings(
  findings: StorefrontFinding[],
  seenFingerprints: ReadonlySet<string>,
  operatorTexts: string[],
): GroupedFindings {
  const groups: GroupedFindings = { new: [], acknowledged: [], in_progress: [] };
  for (const f of findings) {
    // SW tự ghi nhận đang xử lý (acknowledge_finding) là bằng chứng cứng
    // ngang khớp hội thoại — cùng vào nhóm Đang xử lý.
    const swHandling = /acknow|progress|handling/.test(f.swState ?? "");
    if (swHandling || mentionedInConversation(f, operatorTexts)) groups.in_progress.push(f);
    else if (!seenFingerprints.has(f.fingerprint)) groups.new.push(f);
    else groups.acknowledged.push(f);
  }
  return groups;
}

/**
 * Ngữ cảnh Storefront cho prompt draft (dữ liệu, đã neutralize — cùng vai
 * trò với jiraPromptBlock): CHỈ các finding đã khớp hội thoại (kim page/text)
 * mới được đưa vào — finding không liên quan của store không được rò vào
 * draft của một chat không nhắc tới chúng. Trần 5 finding để prompt không
 * phình; mỗi dòng: mức độ · loại lỗi · ngôn ngữ · trang · đoạn text lỗi.
 */
export function storefrontPromptBlock(findings: StorefrontFinding[]): string {
  if (!findings.length) return "";
  return findings.slice(0, 5).map((f) => {
    const head = [f.severity, f.kind ?? f.title, f.locale, f.page].filter(Boolean).join(" · ");
    const detail = f.text ? `: "${oneLineNeutral(f.text, 120)}"` : "";
    return `- ${neutralize(head)}${detail}`;
  }).join("\n");
}

function oneLineNeutral(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// ---------- MCP client ----------

interface McpSession {
  id: string | null;
  nextId: number;
}

export function createStorefrontMcp(opts: {
  token: string;
  signingSecret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  url?: string;
  now?: () => number;
}): StorefrontMcp {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SW_TIMEOUT_MS;
  const url = opts.url ?? SW_MCP_URL;
  const now = opts.now ?? Date.now;
  // Session MCP khoá theo website_id: initialize được ký bằng website đầu
  // tiên nên session của nó không được mang sang request của workspace khác
  // (server có thể bind session với website lúc khởi tạo — dùng chung là rò
  // ngữ cảnh giữa các workspace).
  const sessions = new Map<string, McpSession>();

  async function post(websiteId: string, rawBody: string, sessionId?: string | null): Promise<{ status: number; headers: Headers; text: string }> {
    const ts = String(Math.floor(now() / 1000));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "authorization": `Bearer ${opts.token}`,
      // SW chặn request không User-Agent ở tầng Cloudflare (403/Error 1010) —
      // gửi UA trình duyệt như lần kiểm chứng thành công.
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "X-Crisp-Website-Id": websiteId,
      "X-Crisp-Timestamp": ts,
      "X-Crisp-Signature": await swSignature(opts.signingSecret, ts, websiteId, rawBody),
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method: "POST", headers, body: rawBody, signal: ctrl.signal });
      return { status: res.status, headers: res.headers, text: await res.text() };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new StorefrontError(`Storefront Watch không phản hồi sau ${Math.round(timeoutMs / 1000)} giây`);
      throw new StorefrontError(`Không gọi được Storefront Watch: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** SSE (text/event-stream) thì lấy dòng data: cuối cùng; JSON thuần thì nguyên văn. */
  function parseRpc(text: string): Rec {
    const t = text.trim();
    if (!t) return {};
    if (t.startsWith("{")) {
      try {
        return rec(JSON.parse(t));
      } catch { /* rơi xuống nhánh SSE */ }
    }
    let last: Rec = {};
    for (const line of t.split("\n")) {
      const m = line.match(/^data:\s*(.+)$/);
      if (m) {
        try {
          last = rec(JSON.parse(m[1]));
        } catch { /* dòng data không phải JSON — bỏ */ }
      }
    }
    return last;
  }

  async function rpc(websiteId: string, method: string, params?: unknown, isNotification = false): Promise<Rec> {
    let session = sessions.get(websiteId) ?? null;
    if (!session) {
      const initBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cs-copilot", version: "1.0" } },
      });
      const init = await post(websiteId, initBody);
      if (init.status !== 200) throw new StorefrontError(`Storefront Watch từ chối khởi tạo (HTTP ${init.status})`);
      session = { id: init.headers.get("mcp-session-id"), nextId: 2 };
      sessions.set(websiteId, session);
      // Thông báo initialized không có id, không chờ kết quả — lỗi ở bước này không chặn tools/call.
      const noteBody = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      await post(websiteId, noteBody, session.id).catch(() => null);
    }
    const id = session.nextId++;
    const body = JSON.stringify(isNotification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
    const res = await post(websiteId, body, session.id);
    if (res.status !== 200) {
      // Session có thể đã hết hạn phía server: bỏ session CỦA WEBSITE NÀY để
      // lần gọi sau khởi tạo lại — không đụng session của workspace khác.
      if (res.status === 400 || res.status === 404) sessions.delete(websiteId);
      throw new StorefrontError(`Storefront Watch trả HTTP ${res.status} cho ${method}`);
    }
    const parsed = parseRpc(res.text);
    const err = rec(parsed.error);
    if (Object.keys(err).length) throw new StorefrontError(`Storefront Watch báo lỗi: ${typeof err.message === "string" ? err.message : JSON.stringify(err)}`);
    return rec(parsed.result);
  }

  /** Gọi tool và lấy phần text thô — các tool của SW trả prose (xem mục parse ở trên). */
  async function callToolText(websiteId: string, name: string, args: Rec, allowEmpty = false): Promise<string> {
    const result = await rpc(websiteId, "tools/call", { name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const textPart = content.find((c) => rec(c).type === "text");
    const text = typeof rec(textPart).text === "string" ? rec(textPart).text as string : "";
    if (result.isError === true) {
      // get_finding với fingerprint không tồn tại trả isError + câu này (đã kiểm chứng thật).
      if (/^no finding with fingerprint/i.test(text.trim())) {
        throw new StorefrontError(`Không tìm thấy finding (${text.trim()})`);
      }
      throw new StorefrontError(`Tool ${name} báo lỗi: ${text || "không có chi tiết"}`);
    }
    if (text) return text;
    if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
    // Tool GHI thành công mà không kèm text xác nhận vẫn là thành công — báo
    // lỗi ở đây sẽ khiến panel nói "thất bại" cho một thay đổi ĐÃ xảy ra.
    if (allowEmpty) return "";
    throw new StorefrontError(`Tool ${name} trả về không có nội dung text`);
  }

  return {
    async findStore(websiteId, shop) {
      return parseStoreText(await callToolText(websiteId, "find_store", { shop }), shop);
    },
    async listFindings(websiteId, shop) {
      // include_all=true: UI tự chia 3 trạng thái nên cần cả medium/low, không để server lọc bớt.
      return parseFindingsText(await callToolText(websiteId, "list_findings", { shop, include_all: true }));
    },
    async getFinding(websiteId, fingerprint) {
      return parseFindingDetailText(await callToolText(websiteId, "get_finding", { fingerprint }));
    },
    // operator: tên CS theo account Crisp — schema ghi "leave it out rather
    // than guess" nên chỉ gửi khi caller THẬT SỰ biết tên, rỗng thì bỏ hẳn.
    async acknowledgeFinding(websiteId, fingerprint, operator) {
      const args: Rec = { fingerprint };
      if (operator?.trim()) args.operator = operator.trim();
      return await callToolText(websiteId, "acknowledge_finding", args, true);
    },
    async markFixed(websiteId, fingerprint, note, operator) {
      const args: Rec = { fingerprint, note };
      if (operator?.trim()) args.operator = operator.trim();
      return await callToolText(websiteId, "mark_fixed", args, true);
    },
    async dismissFinding(websiteId, fingerprint, reason, note, operator) {
      const args: Rec = { fingerprint, reason, note };
      if (operator?.trim()) args.operator = operator.trim();
      return await callToolText(websiteId, "dismiss_finding", args, true);
    },
    async undoFinding(websiteId, fingerprint) {
      return await callToolText(websiteId, "undo", { fingerprint }, true);
    },
  };
}

/**
 * Dựng client từ env của Edge Function. Thiếu token hoặc signing secret →
 * null (chưa cấu hình) để action trả trạng thái unconfigured thay vì gọi bừa.
 */
export function storefrontFromEnv(getEnv: (key: string) => string | undefined): StorefrontMcp | null {
  const token = (getEnv("SW_API_TOKEN") ?? "").trim();
  const signingSecret = (getEnv("SW_MCP_SIGNING_SECRET") ?? "").trim();
  if (!token || !signingSecret) return null;
  return createStorefrontMcp({ token, signingSecret });
}
