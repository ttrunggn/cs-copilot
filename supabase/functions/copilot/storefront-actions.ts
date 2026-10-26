import { HttpError } from "../_shared/auth.ts";
import type { CrispClient } from "../_shared/crisp.ts";
import type { Db } from "../_shared/db.ts";
import { enabledModules, jiraForConversation } from "../_shared/jira.ts";
import {
  classifyFindings,
  type StorefrontFinding,
  type StorefrontFindingDetail,
  type StorefrontMcp,
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

function toItem(f: StorefrontFinding): StorefrontItem {
  return {
    fingerprint: f.fingerprint,
    title: f.title,
    meta: f.meta,
    kind: f.kind ?? f.title ?? null,
    locale: f.locale ?? null,
    page: f.page ?? null,
    severity: f.severity ?? null,
    text: f.text ?? null,
    consoleLink: f.consoleLink ?? null,
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
 * lần cho chat thiếu dữ kiện) — trước đây shop tay thắng tuyệt đối khiến một
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

// Lần thử đọc Crisp gần nhất cho từng phiên (theo tiến trình function):
// phiên mà Crisp cũng không có domain thì đừng hỏi lại Crisp ở mọi lần mở
// panel — chờ cửa sổ này rồi mới thử lại (domain có thể được set sau).
const crispLookupAt = new Map<string, number>();
export const CRISP_LOOKUP_TTL_MS = 5 * 60_000;

/**
 * Resolve shopify_domain cho một conversation theo thứ tự: (1) custom_data
 * trong DB (ingest mang về — nguồn chính), (2) đọc thẳng meta.data từ Crisp
 * khi DB chưa có (Ethan chốt 2026-10-26: tự lấy, CS không nhập tay — ca
 * live: domain có sẵn trong Custom data của Crisp mà panel vẫn bắt nhập vì
 * ingest chưa/chậm mang về). Domain lấy được từ Crisp được LƯU LẠI vào
 * custom_data (merge, không đè key khác) và gắn vào chính conv đang cầm để
 * caller dùng tiếp trong cùng request. Lỗi đọc Crisp → coi như chưa có,
 * giữ đường nhập tay làm dự phòng cuối.
 */
export async function resolveShopDomain(
  deps: { db: Db; crisp?: CrispClient | null; now?: () => number },
  websiteId: string,
  sessionId: string,
  conv: ConversationRow | null,
): Promise<string> {
  const known = shopFromCustomData(conv);
  if (known) return known;
  if (!deps.crisp || !conv) return "";
  const key = `${websiteId}|${sessionId}`;
  const now = (deps.now ?? Date.now)();
  if (now - (crispLookupAt.get(key) ?? 0) < CRISP_LOOKUP_TTL_MS) return "";
  crispLookupAt.set(key, now);
  try {
    const data = await deps.crisp.getConversationCustomData(websiteId, sessionId);
    const domain = data?.shopify_domain;
    if (typeof domain !== "string" || !SHOP_OK(domain.trim())) return "";
    const shop = domain.trim();
    await deps.db.mergeConversationCustomData(websiteId, sessionId, { shopify_domain: shop }).catch(() => false);
    conv.custom_data = { ...(conv.custom_data ?? {}), shopify_domain: shop };
    return shop;
  } catch {
    return "";
  }
}

/**
 * Nạp dữ liệu Storefront cho panel: find_store (store có được theo dõi, lần
 * check cuối) + list_findings (mọi lỗi đang mở), rồi chia đúng 3 trạng thái
 * Ethan chốt: Đang xử lý (nội dung finding xuất hiện trong tin CS đã gửi trong
 * chính conversation này) > Mới (fingerprint chưa từng hiện) > Đã xác nhận.
 * Mốc storefront_seen đọc TRƯỚC, ghi SAU khi đã gom nhóm xong.
 */
export async function runStorefront(
  req: { website_id: string; session_id: string; shop?: string },
  ws: Workspace,
  deps: { db: Db; storefront?: StorefrontMcp | null; crisp?: CrispClient | null; now?: () => number },
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
    // "đã contact khách" để suy nhóm Đang xử lý theo mô hình của Ethan.
    const operatorTexts = messages
      .filter((m) => m.from === "operator" && !m.is_bot && m.type === "text")
      .map((m) => m.content);
    const groups = classifyFindings(findings, new Set(seen), operatorTexts);
    await deps.db.markStorefrontSeen(req.website_id, findings.map((f) => f.fingerprint));
    return {
      action: "storefront",
      status: "ok",
      store: store.shop ?? shop,
      scanned_at: store.lastCheckedAt,
      error: null,
      groups: {
        new: groups.new.map(toItem),
        acknowledged: groups.acknowledged.map(toItem),
        in_progress: groups.in_progress.map(toItem),
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
