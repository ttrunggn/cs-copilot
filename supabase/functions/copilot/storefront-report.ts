import type { Db, StorefrontActionLogRow } from "../_shared/db.ts";

/**
 * Report thao tác Storefront Watch lên Google Sheet (Ethan chốt
 * 2026-10-30): panel ghi mỗi thao tác thành công vào bảng
 * storefront_action_log (migration 033); workflow n8n "Storefront
 * Report" gọi 2 action nội bộ này (cùng cổng credential với digest):
 *
 * - storefront_report_pull: trả các dòng CHƯA báo (reported_at null),
 *   cũ nhất trước, đã định dạng sẵn cho Sheet: nhãn thao tác tiếng Việt
 *   + mốc thời gian Asia/Saigon. Pull KHÔNG đánh dấu gì — dòng chỉ được
 *   chốt khi ack về, để append lỗi thì lần sau kéo lại đúng các dòng đó.
 * - storefront_report_ack: {ids} → đặt reported_at cho các id đó.
 *
 * Cột Sheet theo đúng thứ tự header của tab "Log": Thời gian · CS ·
 * Thao tác · Store · Lỗi · Mức độ · Locale · Trang · Lý do Dismiss ·
 * Ghi chú · Link Crisp chat · Link Console.
 */

export const SF_ACT_LABELS: Record<string, string> = {
  acknowledge: "Take case",
  fixed: "Fix",
  dismiss: "Dismiss",
  undo: "Mở lại",
};

export const SF_REASON_LABELS: Record<string, string> = {
  false_signal: "Báo sai, trang vẫn ổn",
  not_important: "Lỗi thật, không đáng sửa",
};

const PULL_LIMIT_MAX = 500;
const PULL_LIMIT_DEFAULT = 200;

const saigonFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Saigon",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Định dạng một dòng log thành đúng 12 cột của Sheet (kèm id để ack). */
export function toSheetRow(r: StorefrontActionLogRow) {
  return {
    id: r.id,
    thoi_gian: saigonFmt.format(new Date(r.created_at)),
    cs: r.operator_name ?? "",
    thao_tac: SF_ACT_LABELS[r.act] ?? r.act,
    store: r.shop,
    loi: r.title ?? "",
    muc_do: r.severity ?? "",
    locale: r.locale ?? "",
    trang: r.page ?? "",
    ly_do: r.reason ? (SF_REASON_LABELS[r.reason] ?? r.reason) : "",
    ghi_chu: r.note ?? "",
    link_crisp: r.crisp_url,
    link_console: r.console_url ?? "",
  };
}

export async function handleStorefrontReportPull(
  body: unknown,
  deps: { db: Db },
): Promise<{ status: number; body: unknown }> {
  const b = (typeof body === "object" && body !== null) ? body as Record<string, unknown> : {};
  const rawLimit = typeof b.limit === "number" && Number.isFinite(b.limit) ? Math.floor(b.limit) : PULL_LIMIT_DEFAULT;
  const limit = Math.min(Math.max(rawLimit, 1), PULL_LIMIT_MAX);
  try {
    const rows = await deps.db.listUnreportedStorefrontActions(limit);
    return { status: 200, body: { action: "storefront_report_pull", rows: rows.map(toSheetRow) } };
  } catch (e) {
    console.error("storefront report pull failed", e);
    return { status: 200, body: { action: "storefront_report_pull", rows: [], skipped: "error" } };
  }
}

export async function handleStorefrontReportAck(
  body: unknown,
  deps: { db: Db },
): Promise<{ status: number; body: unknown }> {
  const b = (typeof body === "object" && body !== null) ? body as Record<string, unknown> : {};
  const ids = Array.isArray(b.ids)
    ? b.ids.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0).slice(0, PULL_LIMIT_MAX)
    : [];
  if (!ids.length) return { status: 400, body: { error: "Thiếu ids" } };
  try {
    await deps.db.markStorefrontActionsReported(ids);
    return { status: 200, body: { action: "storefront_report_ack", acked: ids.length } };
  } catch (e) {
    console.error("storefront report ack failed", e);
    return { status: 200, body: { action: "storefront_report_ack", acked: 0, skipped: "error" } };
  }
}
