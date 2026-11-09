import { assertEquals } from "jsr:@std/assert@1";
import { handleStorefrontReportAck, handleStorefrontReportPull, toSheetRow } from "../copilot/storefront-report.ts";
import type { Db, StorefrontActionLogRow } from "../_shared/db.ts";

function row(over: Partial<StorefrontActionLogRow> = {}): StorefrontActionLogRow {
  return {
    id: 7,
    created_at: "2026-10-30T03:05:09.000Z", // 10:05:09 giờ Saigon
    website_id: "ws1",
    session_id: "session_1",
    operator_name: "Quinn Harper",
    act: "dismiss",
    shop: "shop-x.myshopify.com",
    fingerprint: "a".repeat(40),
    title: "Transient text",
    severity: "high",
    locale: "es",
    page: "/products/abc",
    reason: "false_signal",
    note: null,
    crisp_url: "https://app.crisp.chat/website/ws1/inbox/session_1",
    console_url: "https://sw.transcy.io/#/f/x",
    ...over,
  };
}

Deno.test("report: toSheetRow — nhãn tiếng Việt, lý do dịch sang nhãn, giờ Asia/Saigon", () => {
  const s = toSheetRow(row());
  assertEquals(s, {
    id: 7,
    thoi_gian: "2026-10-30 10:05:09",
    cs: "Quinn Harper",
    thao_tac: "Dismiss",
    store: "shop-x.myshopify.com",
    loi: "Transient text",
    muc_do: "high",
    locale: "es",
    trang: "/products/abc",
    ly_do: "Báo sai, trang vẫn ổn",
    ghi_chu: "",
    link_crisp: "https://app.crisp.chat/website/ws1/inbox/session_1",
    link_console: "https://sw.transcy.io/#/f/x",
  });
});

Deno.test("report pull: trả rows đã định dạng; limit bị kẹp trần 500", async () => {
  let seenLimit = 0;
  const db = {
    listUnreportedStorefrontActions: (limit: number) => {
      seenLimit = limit;
      return Promise.resolve([row(), row({ id: 8, act: "acknowledge", reason: null })]);
    },
  } as unknown as Db;
  const r = await handleStorefrontReportPull({ limit: 9999 }, { db });
  assertEquals(r.status, 200);
  assertEquals(seenLimit, 500);
  const body = r.body as { action: string; rows: ReturnType<typeof toSheetRow>[] };
  assertEquals(body.action, "storefront_report_pull");
  assertEquals(body.rows.length, 2);
  assertEquals(body.rows[1].thao_tac, "Take case");
  assertEquals(body.rows[1].ly_do, "");
});

Deno.test("report pull: DB lỗi → 200 kèm rows rỗng + skipped (job nền không gãy 500)", async () => {
  const db = {
    listUnreportedStorefrontActions: () => Promise.reject(new Error("db down")),
  } as unknown as Db;
  const r = await handleStorefrontReportPull({}, { db });
  assertEquals(r.status, 200);
  assertEquals((r.body as { rows: unknown[]; skipped?: string }).rows, []);
  assertEquals((r.body as { skipped?: string }).skipped, "error");
});

Deno.test("report ack: thiếu ids → 400; ids hợp lệ → đánh dấu đúng các id đó", async () => {
  const marked: number[][] = [];
  const db = {
    markStorefrontActionsReported: (ids: number[]) => {
      marked.push(ids);
      return Promise.resolve();
    },
  } as unknown as Db;
  const bad = await handleStorefrontReportAck({}, { db });
  assertEquals(bad.status, 400);
  const ok = await handleStorefrontReportAck({ ids: [7, 8, -1, "x", 9.5] }, { db });
  assertEquals(ok.status, 200);
  assertEquals((ok.body as { acked: number }).acked, 2);
  assertEquals(marked, [[7, 8]]);
});
