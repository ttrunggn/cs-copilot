import { writeTrace } from "../_shared/trace.ts";
import { HttpError } from "../_shared/auth.ts";
import type { CrispClient } from "../_shared/crisp.ts";
import type { Db, NewStorefrontActionLog } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";
import { toSheetRow } from "./storefront-report.ts";
import { enabledModules, jiraForConversation } from "../_shared/jira.ts";
import {
  classifyFindings,
  consoleUnitUrl,
  storefrontIssuePageUrl,
  storefrontPageUrl,
  SW_DISMISS_REASONS,
  type StorefrontFinding,
  type StorefrontFindingDetail,
  type StorefrontMcp,
  type SwDismissReason,
} from "../_shared/storefront.ts";
import type { ConversationRow, Workspace } from "../_shared/types.ts";

// Fingerprint finding theo inputSchema của get_finding: 40 ký tự hex thường.
export const FINGERPRINT = /^[0-9a-f]{40}$/;

export interface StorefrontItem {
  fingerprint: string;
  title: string;
  meta: string;
  /** Loại lỗi phía SW (vd "Region missing") — widget gom các finding cùng kind+page khác locale thành một mục. */
  kind: string | null;
  locale: string | null;
  page: string | null;
  severity: string | null;
  /** Đoạn text trong vùng lỗi — widget dùng cho mẫu giải thích theo finding. */
  text: string | null;
  /** Link console của CHÍNH finding này (từ dữ kiện MCP) — CS bấm sang đúng trang bug để Mark fixed/Dismiss ở SW. */
  consoleLink: string | null;
  /** URL trang thật trên store ở ngôn ngữ mặc định — link "Default page" cạnh finding trên panel. */
  pageLink: string | null;
  /** URL trang ở đúng locale SW quét thấy lỗi — link "Issue page" cạnh finding trên panel. */
  issuePageLink: string | null;
}

export interface StorefrontResult {
  action: "storefront";
  /** ok = có dữ liệu; not_watched = SW chưa theo dõi store này; unconfigured = server thiếu SW_API_TOKEN/SW_MCP_SIGNING_SECRET; need_shop = không có shop nào dùng được (custom data trống và không truyền shop); error = gọi MCP lỗi (error nói rõ). */
  status: "ok" | "not_watched" | "unconfigured" | "need_shop" | "error";
  store: string | null;
  scanned_at: string | null;
  error: string | null;
  groups: { new: StorefrontItem[]; acknowledged: StorefrontItem[]; in_progress: StorefrontItem[] };
}

export interface StorefrontFindingResult {
  action: "storefront_finding";
  status: "ok" | "unconfigured" | "error";
  error: string | null;
  detail: StorefrontFindingDetail | null;
}

export type StorefrontActKind = "acknowledge" | "fixed" | "dismiss" | "undo";
export const SF_ACTS: readonly StorefrontActKind[] = ["acknowledge", "fixed", "dismiss", "undo"];
/** Trần ghi chú CS nhập cho Fixed/Dismiss (schema SW không ghi trần; 1000 ký tự là dư cho một ghi chú quyết định). */
export const SF_NOTE_MAX = 1000;

export interface StorefrontActResult {
  action: "storefront_act";
  status: "ok" | "unconfigured" | "error";
  act: string;
  error: string | null;
}

const EMPTY_GROUPS = { new: [], acknowledged: [], in_progress: [] };
const UNCONFIGURED_MSG = "Storefront Watch chưa được cấu hình trên server (thiếu SW_API_TOKEN hoặc SW_MCP_SIGNING_SECRET).";

/**
 * Cổng internal connections GIỐNG HỆT `check` (cùng enabledModules, cùng dữ
 * kiện đầu vào): Storefront bật khi (a) chat có ticket thuộc Jira của chính
 * workspace, hoặc (b) đường domain trong phạm vi Storefront Watch (cờ
 * workspaces.storefront_watch — định danh duy nhất của phạm vi, xem
 * enabledModules ở _shared/jira.ts) — shopify_domain của chính conversation
 * + bản chụp SW. "Có ticket" tính trên cùng danh sách check dùng
 * (jiraForConversation với mốc CS nhắn khách thật của conversation, để
 * ticket Done đã báo khách bị loại ở cả hai nơi như nhau). Trước đây action
 * truyền mốc null khiến cổng ở đây lỏng hơn check: check đã tắt module mà
 * gọi thẳng action vẫn qua. Trả conversation để caller dùng lại
 * (custom_data, mốc) khỏi đọc DB hai lần.
 */
async function assertStorefrontEnabled(
  req: { website_id: string; session_id: string },
  ws: Workspace,
  deps: { db: Db; crisp?: CrispClient | null; now?: () => number },
): Promise<ConversationRow | null> {
  const [rows, conv] = await Promise.all([
    deps.db.getJiraRows(req.website_id, req.session_id),
    deps.db.getConversation(req.website_id, req.session_id),
  ]);
  const items = jiraForConversation(rows, conv?.last_human_operator_at ?? null);
  const shop = await resolveShopDomain(deps, req.website_id, req.session_id, conv);
  const snapshot = shop
    ? await deps.db.getStorefrontStoreStatus(req.website_id, shop).catch(() => null)
    : null;
  const gate = { storefrontWatchEnabled: ws.storefront_watch, shopDomain: shop || null, snapshotWatched: snapshot ? snapshot.watched : null };
  if (!enabledModules(items, ws.jira_project, gate).storefront) {
    throw new HttpError(403, "Module Storefront Watch chưa bật cho conversation này (cần ticket thuộc Jira của workspace, hoặc — trong workspace thuộc phạm vi Storefront Watch — shopify_domain mà Storefront Watch đang theo dõi).");
  }
  return conv;
}

function toItem(f: StorefrontFinding, domain?: string | null): StorefrontItem {
  return {
    fingerprint: f.fingerprint,
    title: f.title,
    meta: f.meta,
    kind: f.kind ?? f.title ?? null,
    locale: f.locale ?? null,
    page: f.page ?? null,
    severity: f.severity ?? null,
    text: f.text ?? null,
    // Link panel dùng là URL unit cấu từ domain|locale|page|width (Console
    // mở được dạng này), KHÔNG dùng link fingerprint SW
    // in sẵn (Console báo "no audited unit").
    consoleLink: consoleUnitUrl(domain, f),
    pageLink: storefrontPageUrl(domain, f),
    issuePageLink: storefrontIssuePageUrl(domain, f),
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const SHOP_OK = (s: string) => s.length >= 3 && s.length <= 300 && !/[\s<>"']/.test(s);

/**
 * Shop của conversation: custom data của phiên Crisp (conversations.custom_data
 * — ingest merge từ session data, key `shopify_domain` do integration phía
 * store set) là nguồn SỰ THẬT của chat này và LUÔN THẮNG. Shop widget truyền
 * lên chỉ là fallback khi custom data không có/không hợp lệ (CS nhập tay một
 * lần cho chat thiếu dữ kiện) — nếu shop tay thắng tuyệt đối thì một
 * chat xem được findings của store bất kỳ, lẫn dữ liệu giữa các store.
 * Dữ liệu phía khách ghi được nên vẫn qua cùng lớp kiểm hợp lệ SHOP_OK;
 * không hợp lệ thì coi như chưa có (không 400 — CS không gõ nó).
 * Export để check/generate dùng CHUNG một cách resolve shop cho một
 * conversation — mỗi nơi tự trích custom_data riêng là mầm lẫn dữ liệu.
 */
export function shopFromCustomData(conv: ConversationRow | null): string {
  const fromData = conv?.custom_data?.shopify_domain;
  return typeof fromData === "string" && SHOP_OK(fromData.trim()) ? fromData.trim() : "";
}


const NON_STORE_HOSTS = new Set([
  "crisp.chat", "storage.crisp.chat", "facebook.com", "m.me", "instagram.com",
  "youtube.com", "youtu.be", "google.com", "gstatic.com", "googleapis.com",
  "amazonaws.com", "cloudinary.com", "imgur.com", "tiktok.com", "x.com",
  "twitter.com", "linkedin.com", "pinterest.com", "whatsapp.com", "zalo.me",
  "bit.ly", "tinyurl.com", "shopify.com", "apps.shopify.com", "admin.shopify.com",
]);

/**
 * Domain store ứng viên trích từ LINK KHÁCH GỬI trong chat (khách
 * thường dán link store của họ — vd store-a.example — trong khi custom
 * data của phiên trống; panel phải bắt được đúng store từ đó). Chỉ lấy host
 * từ tin của khách: *.myshopify.com ưu tiên trước, sau đó theo tần suất xuất
 * hiện; host của mạng xã hội/help/lưu trữ ảnh bị loại. Ứng viên CHƯA phải
 * sự thật — caller chỉ nhận khi Storefront Watch xác nhận đang theo dõi
 * (bản chụp sweep), tránh bắt nhầm link lạ khách dán vào.
 */
export function shopCandidatesFromMessages(messages: { from: string; content: string }[]): string[] {
  const freq = new Map<string, number>();
  const bump = (host: string) => {
    const h = host.toLowerCase().replace(/^www\./, "");
    if (!SHOP_OK(h) || NON_STORE_HOSTS.has(h) || h.endsWith(".transcy.io") || h.endsWith(".crisp.chat")) return;
    freq.set(h, (freq.get(h) ?? 0) + 1);
  };
  for (const m of messages) {
    if (m.from !== "user" || !m.content) continue;
    for (const u of m.content.match(/https?:\/\/[^\s<>"'\)\]]+/g) ?? []) {
      try { bump(new URL(u).hostname); } catch { /* link hỏng — bỏ qua */ }
    }
    for (const d of m.content.match(/\b[a-z0-9-]+\.myshopify\.com\b/gi) ?? []) bump(d);
  }
  return [...freq.entries()]
    .sort((a, b) => Number(b[0].endsWith(".myshopify.com")) - Number(a[0].endsWith(".myshopify.com")) || b[1] - a[1])
    .slice(0, 5)
    .map(([h]) => h);
}

// Lần thử đọc Crisp gần nhất cho từng phiên (theo tiến trình function):
// phiên mà Crisp cũng không có domain thì đừng hỏi lại Crisp ở mọi lần mở
// panel — chờ cửa sổ này rồi mới thử lại (domain có thể được set sau).
const crispLookupAt = new Map<string, number>();
export const CRISP_LOOKUP_TTL_MS = 5 * 60_000;

/**
 * Resolve shopify_domain cho một conversation theo thứ tự: (1) custom_data
 * trong DB (ingest mang về — nguồn chính), (2) đọc thẳng meta.data từ Crisp
 * khi DB chưa có (tự lấy, CS không nhập tay — domain có thể đã có trong
 * Custom data của Crisp trong khi ingest chưa/chậm mang về), (3) link khách gửi trong chat — chỉ nhận khi
 * Storefront Watch đang theo dõi domain đó. Domain lấy được từ (2)/(3) đều
 * được LƯU LẠI vào custom_data (merge, không đè key khác) và gắn vào chính
 * conv đang cầm để caller dùng tiếp trong cùng request. Lỗi đọc nguồn →
 * coi như chưa có, giữ đường nhập tay làm dự phòng cuối.
 */
export async function resolveShopDomain(
  deps: { db: Db; crisp?: CrispClient | null; now?: () => number },
  websiteId: string,
  sessionId: string,
  conv: ConversationRow | null,
): Promise<string> {
  const known = shopFromCustomData(conv);
  if (known) return known;
  if (!conv) return "";
  const key = `${websiteId}|${sessionId}`;
  const now = (deps.now ?? Date.now)();
  if (now - (crispLookupAt.get(key) ?? 0) < CRISP_LOOKUP_TTL_MS) return "";
  crispLookupAt.set(key, now);
  const adopt = async (shop: string) => {
    await deps.db.mergeConversationCustomData(websiteId, sessionId, { shopify_domain: shop }).catch(() => false);
    conv.custom_data = { ...(conv.custom_data ?? {}), shopify_domain: shop };
    return shop;
  };
  // (2) Meta của Crisp.
  if (deps.crisp) {
    try {
      const data = await deps.crisp.getConversationCustomData(websiteId, sessionId);
      const domain = data?.shopify_domain;
      if (typeof domain === "string" && SHOP_OK(domain.trim())) return await adopt(domain.trim());
    } catch { /* đọc Crisp lỗi — xuống nguồn (3) */ }
  }
  // (3) Link khách gửi trong chat — chỉ nhận ứng viên Storefront Watch đang
  // theo dõi theo bản chụp sweep; không ứng viên nào khớp thì giữ "" để rơi
  // về đường nhập tay, không bắt bừa một host lạ.
  try {
    const messages = await deps.db.getMessages(websiteId, sessionId, 200);
    for (const cand of shopCandidatesFromMessages(messages).slice(0, 4)) {
      const snap = await deps.db.getStorefrontStoreStatus(websiteId, cand).catch(() => null);
      if (snap?.watched) return await adopt(cand);
    }
  } catch { /* đọc tin/snapshot lỗi — coi như chưa có */ }
  return "";
}

/**
 * Nạp dữ liệu Storefront cho panel: find_store (store có được theo dõi, lần
 * check cuối) + list_findings (mọi lỗi đang mở), rồi chia đúng 3 trạng thái
 * Đang xử lý (nội dung finding xuất hiện trong tin CS đã gửi trong
 * chính conversation này) > Mới (fingerprint chưa từng hiện) > Đã xác nhận.
 * Mốc storefront_seen đọc TRƯỚC, ghi SAU khi đã gom nhóm xong.
 */
export async function runStorefront(
  req: { website_id: string; session_id: string; shop?: string },
  ws: Workspace,
  deps: { db: Db; storefront?: StorefrontMcp | null; crisp?: CrispClient | null; n8n?: N8n | null; now?: () => number },
): Promise<StorefrontResult> {
  const conv = await assertStorefrontEnabled(req, ws, deps);
  const explicit = (req.shop ?? "").trim();
  const shop = shopFromCustomData(conv) || explicit;
  if (explicit && shop === explicit && !SHOP_OK(explicit)) {
    throw new HttpError(400, "shop không hợp lệ (cần domain/link của store, 3–300 ký tự, không khoảng trắng)");
  }
  if (!deps.storefront) {
    return { action: "storefront", status: "unconfigured", store: shop || null, scanned_at: null, error: UNCONFIGURED_MSG, groups: EMPTY_GROUPS };
  }
  if (!shop) {
    return { action: "storefront", status: "need_shop", store: null, scanned_at: null, error: null, groups: EMPTY_GROUPS };
  }
  const mcpT0 = performance.now();
  try {
    const store = await deps.storefront.findStore(req.website_id, shop);
    if (!store.watched) {
      return { action: "storefront", status: "not_watched", store: store.shop ?? shop, scanned_at: store.lastCheckedAt, error: null, groups: EMPTY_GROUPS };
    }
    const [findings, seen, messages] = await Promise.all([
      deps.storefront.listFindings(req.website_id, shop),
      deps.db.getStorefrontSeen(req.website_id),
      deps.db.getMessages(req.website_id, req.session_id, 200),
    ]);
    // Tin CS đã gửi cho khách (không bot, không private note) là bằng chứng
    // "đã contact khách" để suy nhóm Đang xử lý.
    const operatorTexts = messages
      .filter((m) => m.from === "operator" && !m.is_bot && m.type === "text")
      .map((m) => m.content);
    await writeTrace(deps.db, { website_id: req.website_id, session_id: req.session_id, action: "storefront", kind: "timing", stage: "storefront_mcp", duration_ms: Math.round(performance.now() - mcpT0), detail: { findings: findings.length } });
    const groups = classifyFindings(findings, new Set(seen), operatorTexts);
    await deps.db.markStorefrontSeen(req.website_id, findings.map((f) => f.fingerprint));
    return {
      action: "storefront",
      status: "ok",
      store: store.shop ?? shop,
      scanned_at: store.lastCheckedAt,
      error: null,
      groups: {
        new: groups.new.map((f) => toItem(f, store.shop ?? shop)),
        acknowledged: groups.acknowledged.map((f) => toItem(f, store.shop ?? shop)),
        in_progress: groups.in_progress.map((f) => toItem(f, store.shop ?? shop)),
      },
    };
  } catch (e) {
    // Lỗi gọi MCP (StorefrontError) hoặc lỗi DB khi đọc mốc: hiện trung thực
    // trong module thay vì 500 mơ hồ — CS biết là nguồn lỗi chứ không phải "không có lỗi".
    return { action: "storefront", status: "error", store: shop, scanned_at: null, error: errText(e), groups: EMPTY_GROUPS };
  }
}

/**
 * Chi tiết một finding khi CS bấm vào một dòng trong module (get_finding).
 * Finding PHẢI thuộc store của chính conversation này: get_finding của SW tra
 * toàn cục theo fingerprint, nên không đối chiếu thì bất kỳ conversation nào
 * có cổng Storefront cũng xem được finding của store khác (lẫn dữ liệu giữa
 * các store). Đối chiếu bằng list_findings của store đã resolve — fingerprint
 * không nằm trong danh sách đang mở của store đó thì từ chối, không gọi
 * get_finding. (Finding đã đóng trên SW cũng bị từ chối theo cùng đường này:
 * panel chỉ mở chi tiết của finding đang hiển thị, nhất quán.)
 */
export async function runStorefrontFinding(
  req: { website_id: string; session_id: string; fingerprint: string },
  ws: Workspace,
  deps: { db: Db; storefront?: StorefrontMcp | null; crisp?: CrispClient | null; now?: () => number },
): Promise<StorefrontFindingResult> {
  const conv = await assertStorefrontEnabled(req, ws, deps);
  if (!FINGERPRINT.test(req.fingerprint ?? "")) throw new HttpError(400, `fingerprint không hợp lệ: ${req.fingerprint}`);
  if (!deps.storefront) return { action: "storefront_finding", status: "unconfigured", error: UNCONFIGURED_MSG, detail: null };
  const shop = shopFromCustomData(conv);
  if (!shop) {
    return { action: "storefront_finding", status: "error", error: "Chưa xác định được store của conversation này (phiên Crisp không có shopify_domain) nên không đối chiếu được finding.", detail: null };
  }
  try {
    const findings = await deps.storefront.listFindings(req.website_id, shop);
    if (!findings.some((f) => f.fingerprint === req.fingerprint)) {
      return { action: "storefront_finding", status: "error", error: "Finding này không thuộc store của conversation hiện tại.", detail: null };
    }
    const detail = await deps.storefront.getFinding(req.website_id, req.fingerprint);
    return { action: "storefront_finding", status: "ok", error: null, detail };
  } catch (e) {
    return { action: "storefront_finding", status: "error", error: errText(e), detail: null };
  }
}

const normDomain = (s: string) => s.trim().toLowerCase().replace(/^www\./, "").replace(/\/.*$/, "");

/**
 * Thao tác GHI của CS lên một finding ngay trong panel: acknowledge / fixed / dismiss /
 * undo. Đây là đường ghi Storefront Watch DUY NHẤT của copilot và chỉ chạy
 * khi CS bấm nút — không có ghi tự động. Cùng hàng rào với đường đọc:
 * - cổng module giống hệt check (assertStorefrontEnabled);
 * - finding phải thuộc store của chính conversation này: acknowledge/fixed/
 *   dismiss chỉ trên finding ĐANG MỞ của store đó (đối chiếu listFindings);
 *   undo (finding đã đóng, không còn trong list) đối chiếu qua getFinding —
 *   domain trong "Where:" phải khớp store của conversation;
 * - ghi chú KHÔNG bắt buộc cho fixed/dismiss;
 *   dismiss bắt buộc lý do thuộc đúng 2 giá trị schema SW nhận;
 * - tên người thực hiện = operator_name theo account Crisp đang đăng nhập
 *   (handler đã parse; rỗng thì KHÔNG gửi — schema SW: thà bỏ trống còn hơn đoán).
 */
export async function runStorefrontAct(
  req: { website_id: string; session_id: string; fingerprint: string; sf_act: string; note?: string; reason?: string; operator_name?: string },
  ws: Workspace,
  deps: { db: Db; storefront?: StorefrontMcp | null; crisp?: CrispClient | null; n8n?: N8n | null; now?: () => number },
): Promise<StorefrontActResult> {
  const act = req.sf_act as StorefrontActKind;
  const fail = (error: string): StorefrontActResult => ({ action: "storefront_act", status: "error", act: req.sf_act ?? "", error });
  const conv = await assertStorefrontEnabled(req, ws, deps);
  if (!SF_ACTS.includes(act)) throw new HttpError(400, `sf_act không hợp lệ: ${req.sf_act}`);
  if (!FINGERPRINT.test(req.fingerprint ?? "")) throw new HttpError(400, `fingerprint không hợp lệ: ${req.fingerprint}`);
  const note = (req.note ?? "").trim();
  // Ghi chú KHÔNG bắt buộc cho cả fixed lẫn dismiss (bên SW dismiss chỉ
  // cần lý do, fix cũng vậy). Có ghi thì Console hiện kèm quyết định.
  if (note.length > SF_NOTE_MAX) throw new HttpError(400, `Ghi chú quá dài (tối đa ${SF_NOTE_MAX} ký tự).`);
  const reason = (req.reason ?? "").trim() as SwDismissReason;
  if (act === "dismiss" && !(SW_DISMISS_REASONS as readonly string[]).includes(reason)) {
    throw new HttpError(400, "Dismiss cần lý do: false_signal (báo sai, trang vẫn ổn) hoặc not_important (lỗi thật, không đáng sửa).");
  }
  if (!deps.storefront) return { action: "storefront_act", status: "unconfigured", act, error: UNCONFIGURED_MSG };
  const shop = shopFromCustomData(conv);
  if (!shop) return fail("Chưa xác định được store của conversation này (phiên Crisp không có shopify_domain) nên không đối chiếu được finding.");
  const operator = (req.operator_name ?? "").trim() || undefined;
  const t0 = performance.now();
  try {
    let logSource: StorefrontFinding | null = null;
    if (act === "undo") {
      const detail = await deps.storefront.getFinding(req.website_id, req.fingerprint);
      if (!detail.dismissed && !detail.fixed) return fail("Finding này đang mở, không có gì để mở lại.");
      const whereDomain = normDomain((detail.where ?? "").split(" · ")[0] ?? "");
      let canonical = "";
      try {
        canonical = normDomain((await deps.storefront.findStore(req.website_id, shop)).shop ?? "");
      } catch { /* find_store lỗi thì chỉ còn mốc domain đã resolve để đối chiếu */ }
      if (!whereDomain || (whereDomain !== normDomain(shop) && whereDomain !== canonical)) {
        return fail("Finding này không thuộc store của conversation hiện tại.");
      }
      await deps.storefront.undoFinding(req.website_id, req.fingerprint);
      logSource = detail;
    } else {
      const findings = await deps.storefront.listFindings(req.website_id, shop);
      const finding = findings.find((f) => f.fingerprint === req.fingerprint);
      if (!finding) {
        return fail("Finding này không thuộc store của conversation hiện tại.");
      }
      if (act === "acknowledge") await deps.storefront.acknowledgeFinding(req.website_id, req.fingerprint, operator);
      else if (act === "fixed") await deps.storefront.markFixed(req.website_id, req.fingerprint, note, operator);
      else await deps.storefront.dismissFinding(req.website_id, req.fingerprint, reason, note, operator);
      logSource = finding;
    }
    // Nhật ký report Google Sheet (migration 033): ghi
    // SAU khi SW đã nhận thao tác. Lỗi ghi log KHÔNG được phá kết quả trả
    // cho CS (thao tác thật đã xong) — nuốt lỗi, chỉ để lại trace.
    const logRow: NewStorefrontActionLog = {
      website_id: req.website_id,
      session_id: req.session_id,
      operator_name: operator ?? null,
      act,
      shop,
      fingerprint: req.fingerprint,
      title: logSource?.title ?? null,
      severity: logSource?.severity ?? null,
      locale: logSource?.locale ?? null,
      page: logSource?.page ?? null,
      reason: act === "dismiss" ? reason : null,
      note: note || null,
      crisp_url: `https://app.crisp.chat/website/${req.website_id}/inbox/${req.session_id}`,
      console_url: logSource ? (logSource.consoleLink ?? consoleUnitUrl(shop, logSource)) : null,
    };
    let loggedId: number | null = null;
    try {
      loggedId = await deps.db.insertStorefrontActionLog(logRow);
    } catch (logErr) {
      await writeTrace(deps.db, { website_id: req.website_id, session_id: req.session_id, action: "storefront_act", kind: "error", stage: "storefront_act_log", detail: { act, error: errText(logErr) } }).catch(() => null);
    }
    // Đẩy REAL-TIME lên Sheet qua webhook n8n (team cần track liên tục,
    // không chờ lượt gom định kỳ). Đẩy hỏng thì dòng vẫn chưa reported —
    // workflow pull lấp lại, không mất dòng. Kết quả cú đẩy (kèm
    // status/lỗi) PHẢI vào trace, nuốt im lặng thì lỗi không truy được.
    let pushOutcome: Record<string, unknown> = { skipped: loggedId === null ? "no_id" : "no_n8n" };
    if (loggedId !== null && deps.n8n) {
      const sheetRow = toSheetRow({ ...logRow, id: loggedId, created_at: new Date().toISOString() });
      pushOutcome = await deps.n8n.pushStorefrontReport(sheetRow as unknown as Record<string, unknown>)
        .catch((e) => ({ ok: false, error: errText(e) }));
    }
    await writeTrace(deps.db, { website_id: req.website_id, session_id: req.session_id, action: "storefront_act", kind: "timing", stage: "storefront_act", duration_ms: Math.round(performance.now() - t0), detail: { act, logged_id: loggedId, push: pushOutcome } });
    return { action: "storefront_act", status: "ok", act, error: null };
  } catch (e) {
    return fail(errText(e));
  }
}
