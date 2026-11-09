import type { Db } from "../_shared/db.ts";
import type { OperatorMailer } from "../_shared/crisp-operators.ts";
import {
  consoleUnitUrl,
  type StorefrontFinding,
  type StorefrontMcp,
  storeStatusFromStore,
} from "../_shared/storefront.ts";
import { SWEEP_RECENT_DAYS } from "./storefront-sweep.ts";

/** Tiêu đề email cố định. */
export const DIGEST_SUBJECT = "Storefront Watch Weekly Scan";

export interface DigestResult {
  checked: number;
  seeded: number;
  changed: number;
  reported: number;
  emailed: boolean;
  failed: number;
  skipped: string | null;
  email_error: string | null;
}

/** Link mở thẳng conversation trong Crisp (định dạng inbox chuẩn của Crisp). */
export function crispInboxUrl(websiteId: string, sessionId: string): string {
  return `https://app.crisp.chat/website/${websiteId}/inbox/${sessionId}`;
}

export interface DigestLine {
  shop: string;
  /** Số lỗi MỚI của store trong đợt này (đã gom trùng căn nguyên như panel). */
  newCount: number;
  crispUrl: string | null;
  consoleUrl: string;
}

/**
 * Đếm lỗi theo ĐÚNG quy tắc gom của panel (widget/core.js): finding trùng
 * căn nguyên — cùng kind + page, chỉ khác locale — tính là MỘT lỗi; finding
 * thiếu kind hoặc page đứng riêng. Email báo số này để khớp với số CS thấy
 * khi mở panel, không báo số finding thô của SW.
 */
export function countFindingGroups(findings: StorefrontFinding[]): number {
  const keys = new Set<string>();
  for (const f of findings) {
    keys.add(f.kind && f.page ? `${f.kind}|${f.page}` : `fp:${f.fingerprint}`);
  }
  return keys.size;
}

/**
 * Link Console của store: unit link dựng từ finding mới đầu tiên (builder
 * tin cậy của repo); thiếu mảnh thì lùi về consoleLink SW trả kèm; cuối
 * cùng là trang gốc SW (đúng nút "Mở Storefront Watch" của panel).
 */
export function consoleUrlForStore(shop: string, fresh: StorefrontFinding[]): string {
  const first = fresh[0];
  if (first) {
    const unit = consoleUnitUrl(shop, first);
    if (unit) return unit;
    if (first.consoleLink) return first.consoleLink;
  }
  return "https://sw.transcy.io";
}

/**
 * Body email: mỗi store một khối gồm đúng
 * domain, số lỗi mới, link Crisp, link Console. Không lời dẫn, không chi
 * tiết finding, không ngữ cảnh nào thêm. Store chưa từng có session nào
 * thì bỏ dòng Crisp (không có link để gắn — không bịa link chết).
 */
export function buildDigestMessage(lines: DigestLine[]): string {
  return lines
    .map((l) => {
      const rows = [
        `shopify_domain: ${l.shop}`,
        `${l.newCount} lỗi mới`,
        ...(l.crispUrl ? [`Crisp: ${l.crispUrl}`] : []),
        `Console: ${l.consoleUrl}`,
      ];
      return rows.join("\n");
    })
    .join("\n\n");
}

interface PendingStore {
  shop: string;
  lastGoodCheck: string | null;
  fresh: StorefrontFinding[];
}

/**
 * Job email digest Storefront Watch (route nội bộ trong function copilot —
 * index.ts chặn bằng credential nội bộ như storefront_sweep; một bộ lập
 * lịch ngoài, vd n8n timer chạy hằng ngày, gọi job này).
 *
 * Việc của job: với workspace trong phạm vi SW (cờ workspaces.storefront_watch),
 * lấy các domain duy nhất từ conversation 30 ngày gần nhất (cùng tập với
 * sweep), gọi find_store từng domain và so "Last good check" với mốc digest
 * riêng (bảng storefront_digest_*, migration 031 — tách khỏi mốc panel):
 *
 * - Store CHƯA có mốc: chỉ ghi nền (fingerprint đang mở + mốc hiện tại),
 *   KHÔNG báo — email không bao giờ chứa tồn đọng của các đợt trước.
 * - Mốc KHÔNG đổi: chưa có đợt quét mới — bỏ qua, không gọi list_findings.
 * - Mốc ĐỔI (đợt quét mới): list_findings, bug mới = fingerprint đang mở
 *   mà digest chưa tính. Không có bug mới → nâng mốc lặng lẽ. Có bug mới →
 *   gom vào email chung của lần chạy.
 *
 * Sau khi gom: gửi ĐÚNG 1 email tới toàn bộ operator (subject cố định
 * DIGEST_SUBJECT, body mỗi store một khối domain + số lỗi mới + link Crisp
 * của session gần nhất có shopify_domain đó + link Console — ngoài 4 dữ
 * kiện này không thêm ngữ cảnh nào). Mốc + fingerprint của các store được
 * báo chỉ nâng SAU KHI Crisp nhận email thành công — gửi lỗi thì lần chạy
 * sau tính lại đúng đợt đó (email_error trả trong kết quả, không nuốt).
 *
 * Kèm theo: upsert bản chụp storefront_store_status (như sweep) để panel
 * luôn có mốc quét tươi dù sweep chưa được lập lịch riêng.
 *
 * Read-only với SW (find_store/list_findings); ghi Crisp DUY NHẤT là email
 * nội bộ cho operator qua _shared/crisp-operators.ts.
 */
export async function runStorefrontDigest(
  deps: { db: Db; storefront?: StorefrontMcp | null; mailer?: OperatorMailer | null; now?: () => number },
  websiteId: string,
): Promise<DigestResult> {
  const base: DigestResult = {
    checked: 0,
    seeded: 0,
    changed: 0,
    reported: 0,
    emailed: false,
    failed: 0,
    skipped: null,
    email_error: null,
  };
  const ws = await deps.db.getWorkspace(websiteId).catch(() => null);
  if (!ws) return { ...base, skipped: "unknown_workspace" };
  if (!ws.storefront_watch) return { ...base, skipped: "not_transcy_workspace" };
  if (!deps.storefront) return { ...base, skipped: "unconfigured" };
  if (!deps.mailer) return { ...base, skipped: "mail_unconfigured" };
  const domains = await deps.db.getRecentShopDomains(websiteId, SWEEP_RECENT_DAYS);
  const fetchedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const out = { ...base };
  const pending: PendingStore[] = [];
  for (const shop of domains) {
    out.checked++;
    try {
      const store = await deps.storefront.findStore(websiteId, shop);
      await deps.db.upsertStorefrontStoreStatus(storeStatusFromStore(websiteId, shop, store, fetchedAt));
      if (!store.watched) continue;
      const state = await deps.db.getDigestState(websiteId, shop);
      if (!state) {
        const current = await deps.storefront.listFindings(websiteId, shop);
        await deps.db.addDigestFindings(websiteId, shop, current.map((f) => f.fingerprint));
        await deps.db.setDigestState(websiteId, shop, store.lastCheckedAt);
        out.seeded++;
        continue;
      }
      if (store.lastCheckedAt === state.last_good_check) continue;
      out.changed++;
      const current = await deps.storefront.listFindings(websiteId, shop);
      const known = new Set(await deps.db.getDigestFindings(websiteId, shop));
      const fresh = current.filter((f) => !known.has(f.fingerprint));
      if (!fresh.length) {
        await deps.db.addDigestFindings(websiteId, shop, current.map((f) => f.fingerprint));
        await deps.db.setDigestState(websiteId, shop, store.lastCheckedAt);
        continue;
      }
      pending.push({ shop, lastGoodCheck: store.lastCheckedAt, fresh });
    } catch (e) {
      console.error("storefront digest: lỗi xử lý store", shop, e);
      out.failed++;
    }
  }
  if (!pending.length) return out;
  const lines: DigestLine[] = [];
  for (const p of pending) {
    const sessionId = await deps.db.getLatestSessionForShop(websiteId, p.shop).catch(() => null);
    lines.push({
      shop: p.shop,
      newCount: countFindingGroups(p.fresh),
      crispUrl: sessionId ? crispInboxUrl(websiteId, sessionId) : null,
      consoleUrl: consoleUrlForStore(p.shop, p.fresh),
    });
  }
  try {
    await deps.mailer.sendOperatorEmail(websiteId, {
      subject: DIGEST_SUBJECT,
      message: buildDigestMessage(lines),
    });
  } catch (e) {
    out.email_error = e instanceof Error ? e.message : String(e);
    return out;
  }
  out.emailed = true;
  out.reported = pending.length;
  for (const p of pending) {
    await deps.db.addDigestFindings(websiteId, p.shop, p.fresh.map((f) => f.fingerprint));
    await deps.db.setDigestState(websiteId, p.shop, p.lastGoodCheck);
  }
  return out;
}

export async function handleStorefrontDigest(
  body: unknown,
  deps: { db: Db; storefront?: StorefrontMcp | null; mailer?: OperatorMailer | null },
): Promise<{ status: number; body: unknown }> {
  const b = (typeof body === "object" && body !== null) ? body as Record<string, unknown> : {};
  const websiteId = typeof b.website_id === "string" ? b.website_id : "";
  if (!websiteId) return { status: 400, body: { error: "Thiếu website_id" } };
  try {
    const r = await runStorefrontDigest(deps, websiteId);
    return { status: 200, body: { action: "storefront_digest", ...r } };
  } catch (e) {
    // Như sweep: việc nền không bao giờ được gãy thành 500 mơ hồ — trả 200
    // kèm skipped để phía lập lịch biết mà không retry dồn dập.
    console.error("storefront digest failed", e);
    return {
      status: 200,
      body: {
        action: "storefront_digest",
        checked: 0,
        seeded: 0,
        changed: 0,
        reported: 0,
        emailed: false,
        failed: 0,
        skipped: "error",
        email_error: null,
      },
    };
  }
}
