import { STOREFRONT_WATCH_SEGMENT, type CrispClient } from "../_shared/crisp.ts";
import type { Db } from "../_shared/db.ts";
import { SWEEP_RECENT_DAYS } from "./storefront-sweep.ts";

/**
 * Trần số PATCH (thay đổi thật) trong một lượt chạy — plugin token của
 * Crisp có quota 5.000 req/ngày. GET kiểm chứng trước khi ghi KHÔNG tính
 * vào trần: mirror chậm cập nhật sinh diff "ảo" (Crisp đã đúng rồi), các
 * diff đó không được ăn slot, nếu không backlog thật sẽ không bao giờ
 * thoát. Diff cần PATCH mà vượt trần nằm ở `backlog` cho lượt sau.
 */
export const MAX_SEGMENT_CHANGES_PER_RUN = 200;

export interface SegmentSyncResult {
  tagged: number;
  untagged: number;
  unchanged: number;
  failed: number;
  backlog: number;
  skipped: string | null;
}

/**
 * MERGE danh sách segments: thêm/gỡ ĐÚNG segment `storefront-watch`, giữ
 * nguyên mọi segment khác và thứ tự của chúng (segment lạ do CS gắn tay
 * không bao giờ bị đụng). Thuần, không I/O — PATCH của Crisp ghi đè cả
 * trường segments nên danh sách ghi đi PHẢI là kết quả merge từ bản thật
 * vừa đọc, không bao giờ là danh sách dựng từ mirror DB.
 */
export function withStorefrontSegment(current: string[], want: boolean): string[] {
  const has = current.includes(STOREFRONT_WATCH_SEGMENT);
  if (want) return has ? [...current] : [...current, STOREFRONT_WATCH_SEGMENT];
  return current.filter((s) => s !== STOREFRONT_WATCH_SEGMENT);
}

/**
 * Job đồng bộ segment `storefront-watch` (route nội bộ trong function
 * copilot — index.ts chặn bằng credential nội bộ như precompute_sentiment /
 * storefront_sweep; bộ lập lịch ngoài, vd n8n timer, gọi NGAY SAU
 * storefront_sweep để bản chụp là mới nhất. Hai handler độc lập nhau.)
 *
 * Ngoại lệ ghi Crisp DUY NHẤT được cho phép tường minh: hệ
 * thống tự gắn segment `storefront-watch` lên các conversation thuộc store
 * đang có lỗi mở trong Storefront Watch — để chat tự nổi lên trong inbox
 * thay vì bắt CS vào SW search — và tự gỡ khi store hết lỗi. Đây là ghi
 * metadata: không tin nhắn, không note, khách không nhìn thấy. Ngoài
 * segment này ra, job không đụng bất kỳ segment/dữ kiện nào khác của
 * conversation (mọi lần ghi đều merge trên bản segments THẬT vừa đọc từ
 * Crisp API).
 *
 * Nguồn sự thật cho trạng thái MONG MUỐN là bản chụp
 * storefront_store_status (job sweep ghi): store có watched = true và
 * open_total > 0 → conversation của store đó PHẢI có segment; ngoài ra
 * (hết lỗi, không còn được theo dõi, không có trong bản chụp) → PHẢI gỡ.
 *
 * Phạm vi khoá cứng ở workspace có cờ workspaces.storefront_watch = true
 * (định danh duy nhất của phạm vi SW, migration 023): workspace khác → bỏ
 * qua, KHÔNG một lời gọi Crisp nào — kể cả khi chat của họ có
 * shopify_domain (domain không chứng minh được store thuộc Transcy).
 *
 * Idempotent + tiết kiệm quota: trạng thái hiện tại tính từ segments
 * mirror trong DB (ingest bắt session:set_segments) — không có diff thì
 * KHÔNG gọi Crisp. Có diff mới đọc lại conversation từ Crisp API rồi merge
 * trên bản thật (mirror có thể chậm hơn thao tác gắn tay của CS); bản thật
 * đã đúng thì không PATCH. Chạy lại khi không còn diff → 0 lời gọi ghi.
 * Lỗi ở MỘT conversation chỉ tính vào `failed`, không chặn phần còn lại.
 */
export async function runStorefrontSegments(
  deps: { db: Db; crisp?: CrispClient | null; maxChanges?: number },
  websiteId: string,
): Promise<SegmentSyncResult> {
  const base: SegmentSyncResult = { tagged: 0, untagged: 0, unchanged: 0, failed: 0, backlog: 0, skipped: null };
  const ws = await deps.db.getWorkspace(websiteId).catch(() => null);
  if (!ws) return { ...base, skipped: "unknown_workspace" };
  if (!ws.storefront_watch) return { ...base, skipped: "not_transcy_workspace" };
  if (!deps.crisp) return { ...base, skipped: "unconfigured" };
  const [statuses, candidates] = await Promise.all([
    deps.db.listStorefrontStoreStatus(websiteId),
    deps.db.getStorefrontSegmentCandidates(websiteId, SWEEP_RECENT_DAYS),
  ]);
  const goodShops = new Set(statuses.filter((s) => s.watched && s.open_total > 0).map((s) => s.shop));
  const out = { ...base };
  const diffs: { sessionId: string; want: boolean }[] = [];
  for (const c of candidates) {
    const want = c.shop !== null && goodShops.has(c.shop);
    const has = c.segments.includes(STOREFRONT_WATCH_SEGMENT);
    if (want === has) out.unchanged++;
    else diffs.push({ sessionId: c.session_id, want });
  }
  // Thứ tự tất định theo session_id để hành vi mỗi lượt chạy lặp lại được
  // (và phần backlog ổn định qua các lượt).
  diffs.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  const cap = deps.maxChanges ?? MAX_SEGMENT_CHANGES_PER_RUN;
  let changes = 0;
  for (const d of diffs) {
    try {
      // Đọc bản THẬT ngay trước khi ghi: mirror có thể chưa kịp cập nhật
      // segment CS vừa gắn tay — merge phải đi từ bản thật này.
      const real = await deps.crisp.getConversationSegments(websiteId, d.sessionId);
      if (real.includes(STOREFRONT_WATCH_SEGMENT) === d.want) {
        out.unchanged++; // mirror cũ — Crisp đã đúng trạng thái, khỏi tốn PATCH
        continue;
      }
      if (changes >= cap) {
        out.backlog++; // cần PATCH thật nhưng đã chạm trần lượt này
        continue;
      }
      await deps.crisp.setConversationSegments(websiteId, d.sessionId, withStorefrontSegment(real, d.want));
      changes++;
      if (d.want) out.tagged++;
      else out.untagged++;
    } catch (e) {
      console.error("storefront segments: sync failed", d.sessionId, e);
      out.failed++;
    }
  }
  return out;
}

export async function handleStorefrontSegments(
  body: unknown,
  deps: { db: Db; crisp?: CrispClient | null },
): Promise<{ status: number; body: unknown }> {
  const b = (typeof body === "object" && body !== null) ? body as Record<string, unknown> : {};
  const websiteId = typeof b.website_id === "string" ? b.website_id : "";
  if (!websiteId) return { status: 400, body: { error: "Thiếu website_id" } };
  try {
    const r = await runStorefrontSegments(deps, websiteId);
    return { status: 200, body: { action: "storefront_segments", ...r } };
  } catch (e) {
    // Như sweep/precompute: việc nền không bao giờ được gãy thành 500 mơ hồ —
    // trả 200 kèm skipped để phía lập lịch biết mà không retry dồn dập.
    console.error("storefront segments failed", e);
    return { status: 200, body: { action: "storefront_segments", tagged: 0, untagged: 0, unchanged: 0, failed: 0, backlog: 0, skipped: "error" } };
  }
}
