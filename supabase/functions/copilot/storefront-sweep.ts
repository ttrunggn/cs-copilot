import type { Db } from "../_shared/db.ts";
import {
  type StorefrontMcp,
  storeStatusFromStore,
} from "../_shared/storefront.ts";

/** Số ngày nhìn lại khi gom domain từ conversation: store còn "nóng" với CS trong cửa sổ này mới đáng quét nền. */
export const SWEEP_RECENT_DAYS = 30;

export interface SweepResult {
  checked: number;
  watched: number;
  with_problems: number;
  failed: number;
  skipped: string | null;
}

/**
 * Job đối chiếu nền Storefront Watch (route nội bộ trong function copilot —
 * index.ts chặn bằng credential nội bộ như precompute_sentiment; một bộ
 * lập lịch ngoài, vd n8n timer, gọi sau các đợt quét của SW).
 *
 * Việc của job: với workspace trong phạm vi Storefront Watch (nhận diện
 * TƯỜNG MINH bằng cờ workspaces.storefront_watch — định danh duy nhất của
 * phạm vi SW, xem enabledModules), lấy các domain DUY NHẤT từ
 * custom_data.shopify_domain của các conversation trong 30 ngày gần nhất,
 * gọi find_store từng domain và UPSERT bản chụp vào storefront_store_status.
 * Nhờ bản chụp này, panel biết ngay store của một chat có lỗi mở hay không
 * (badge ở Issue logs + cổng Storefront) mà không phải chờ CS mở module hay
 * tự đi search — đúng điểm mù Ethan chỉ ra: SW chỉ quét theo domain, CS
 * không search thì không bao giờ biết khách nào đang có bug.
 *
 * Idempotent tuyệt đối: bản chụp ghi theo PK (website_id, shop) bằng upsert
 * — chạy lại ghi đè cùng dữ kiện, không nhân dòng, không cộng dồn số đếm.
 * Lỗi ở MỘT domain (MCP chập chờn) chỉ tính vào `failed`, không chặn các
 * domain còn lại và không xoá bản chụp cũ của domain đó.
 *
 * Read-only với SW (chỉ find_store); KHÔNG gắn nhãn/ghi gì lên Crisp,
 * KHÔNG kích quét (SW không có tool scan và panel cũng không scan).
 */
export async function runStorefrontSweep(
  deps: { db: Db; storefront?: StorefrontMcp | null; now?: () => number },
  websiteId: string,
): Promise<SweepResult> {
  const base: SweepResult = { checked: 0, watched: 0, with_problems: 0, failed: 0, skipped: null };
  const ws = await deps.db.getWorkspace(websiteId).catch(() => null);
  if (!ws) return { ...base, skipped: "unknown_workspace" };
  // Chỉ workspace trong phạm vi SW (cờ storefront_watch bật — hiện chỉ bật
  // cho workspace của chính Transcy khi deploy) mới có ý niệm "store của
  // khách mình" ở đây: workspace khác cũng có jira_project riêng (OES) và
  // cũng có shopify_domain trong visitor data của họ (đính chính của
  // Ethan) — quét domain của workspace khác là lẫn dữ liệu. KHÔNG suy phạm
  // vi từ jira_project.
  if (!ws.storefront_watch) return { ...base, skipped: "not_transcy_workspace" };
  if (!deps.storefront) return { ...base, skipped: "unconfigured" };
  const domains = await deps.db.getRecentShopDomains(websiteId, SWEEP_RECENT_DAYS);
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const out = { ...base };
  for (const shop of domains) {
    out.checked++;
    try {
      const store = await deps.storefront.findStore(websiteId, shop);
      const row = storeStatusFromStore(websiteId, shop, store, fetchedAt);
      await deps.db.upsertStorefrontStoreStatus(row);
      if (row.watched) out.watched++;
      if (row.open_total > 0) out.with_problems++;
    } catch (e) {
      console.error("storefront sweep: find_store/upsert failed", shop, e);
      out.failed++;
    }
  }
  return out;
}

export async function handleStorefrontSweep(
  body: unknown,
  deps: { db: Db; storefront?: StorefrontMcp | null },
): Promise<{ status: number; body: unknown }> {
  const b = (typeof body === "object" && body !== null) ? body as Record<string, unknown> : {};
  const websiteId = typeof b.website_id === "string" ? b.website_id : "";
  if (!websiteId) return { status: 400, body: { error: "Thiếu website_id" } };
  try {
    const r = await runStorefrontSweep(deps, websiteId);
    return { status: 200, body: { action: "storefront_sweep", ...r } };
  } catch (e) {
    // Như precompute: việc nền không bao giờ được gãy thành 500 mơ hồ —
    // trả 200 kèm skipped để phía lập lịch biết mà không retry dồn dập.
    console.error("storefront sweep failed", e);
    return { status: 200, body: { action: "storefront_sweep", checked: 0, watched: 0, with_problems: 0, failed: 0, skipped: "error" } };
  }
}
