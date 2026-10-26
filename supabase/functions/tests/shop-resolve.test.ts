import { assertEquals } from "jsr:@std/assert@1";
import type { Db } from "../_shared/db.ts";
import type { ConversationRow } from "../_shared/types.ts";
import { resolveShopDomain } from "../copilot/storefront-actions.ts";

// Tự resolve shopify_domain: DB trước, Crisp meta sau (và lưu lại vào DB).
// Mỗi test dùng session_id riêng để memo theo phiên trong module không rò
// sang nhau.

function conv(sessionId: string, custom: Record<string, unknown> = {}): ConversationRow {
  return {
    website_id: "ws1", session_id: sessionId, customer_email: null, customer_name: null,
    topic: null, topic_source: null, state: "unresolved",
    last_customer_at: null, last_human_operator_at: null, updated_at: "2026-10-15T03:00:00+00:00",
    custom_data: custom,
  };
}

function fakeDb(merges: { patch: Record<string, unknown> }[]) {
  return {
    mergeConversationCustomData: (_w: string, _s: string, patch: Record<string, unknown>) => {
      merges.push({ patch });
      return Promise.resolve(true);
    },
  } as unknown as Db;
}

Deno.test("resolve shop: DB đã có domain -> dùng luôn, không hỏi Crisp", async () => {
  let crispCalls = 0;
  const shop = await resolveShopDomain(
    { db: fakeDb([]), crisp: { getConversationCustomData: () => { crispCalls++; return Promise.resolve(null); }, getConversationSegments: () => Promise.resolve([]), setConversationSegments: () => Promise.resolve() } },
    "ws1", "s_db", conv("s_db", { shopify_domain: "co-san.myshopify.com" }),
  );
  assertEquals(shop, "co-san.myshopify.com");
  assertEquals(crispCalls, 0);
});

Deno.test("resolve shop: DB trống -> lấy từ Crisp, lưu lại vào DB và gắn vào conv", async () => {
  const merges: { patch: Record<string, unknown> }[] = [];
  const c = conv("s_crisp");
  const shop = await resolveShopDomain(
    { db: fakeDb(merges), crisp: { getConversationCustomData: () => Promise.resolve({ shopify_domain: "iaewrj-tr.myshopify.com", other: 1 }), getConversationSegments: () => Promise.resolve([]), setConversationSegments: () => Promise.resolve() } },
    "ws1", "s_crisp", c,
  );
  assertEquals(shop, "iaewrj-tr.myshopify.com");
  assertEquals(merges, [{ patch: { shopify_domain: "iaewrj-tr.myshopify.com" } }]);
  assertEquals(c.custom_data?.shopify_domain, "iaewrj-tr.myshopify.com");
});

Deno.test("resolve shop: Crisp không có domain -> rỗng và không hỏi lại trong cửa sổ TTL", async () => {
  let crispCalls = 0;
  let t = 1_000_000;
  const deps = {
    db: fakeDb([]),
    crisp: { getConversationCustomData: () => { crispCalls++; return Promise.resolve({}); }, getConversationSegments: () => Promise.resolve([]), setConversationSegments: () => Promise.resolve() },
    now: () => t,
  };
  assertEquals(await resolveShopDomain(deps, "ws1", "s_none", conv("s_none")), "");
  t += 60_000; // 1 phút sau: vẫn trong TTL 5 phút
  assertEquals(await resolveShopDomain(deps, "ws1", "s_none", conv("s_none")), "");
  assertEquals(crispCalls, 1);
  t += 6 * 60_000; // quá TTL: hỏi lại
  assertEquals(await resolveShopDomain(deps, "ws1", "s_none", conv("s_none")), "");
  assertEquals(crispCalls, 2);
});

Deno.test("resolve shop: Crisp lỗi hoặc domain không hợp lệ -> rỗng, không văng lỗi", async () => {
  const boom = await resolveShopDomain(
    { db: fakeDb([]), crisp: { getConversationCustomData: () => Promise.reject(new Error("HTTP 500")), getConversationSegments: () => Promise.resolve([]), setConversationSegments: () => Promise.resolve() } },
    "ws1", "s_err", conv("s_err"),
  );
  assertEquals(boom, "");
  const bad = await resolveShopDomain(
    { db: fakeDb([]), crisp: { getConversationCustomData: () => Promise.resolve({ shopify_domain: "có khoảng trắng" }), getConversationSegments: () => Promise.resolve([]), setConversationSegments: () => Promise.resolve() } },
    "ws1", "s_bad", conv("s_bad"),
  );
  assertEquals(bad, "");
});

import { shopCandidatesFromMessages } from "../copilot/storefront-actions.ts";

Deno.test("shop candidates: trích host từ link khách gửi — myshopify trước, host lạ/mạng xã hội bị loại, chỉ tin khách", () => {
  const cands = shopCandidatesFromMessages([
    { from: "user", content: "my store https://lauravita.com/collections/boots/products/anita and fb https://facebook.com/x" },
    { from: "user", content: "also https://lauravita.com/products/other plus app link https://apps.shopify.com/transcy" },
    { from: "operator", content: "check https://operator-link.com/please" },
    { from: "user", content: "backup domain lauravita-123.myshopify.com here" },
  ]);
  assertEquals(cands, ["lauravita-123.myshopify.com", "lauravita.com"]);
});

Deno.test("resolve shop: DB + Crisp đều trống → lấy domain từ link khách gửi khi SW đang theo dõi, lưu lại", async () => {
  const merges: { patch: Record<string, unknown> }[] = [];
  const db = {
    mergeConversationCustomData: (_w: string, _s: string, patch: Record<string, unknown>) => { merges.push({ patch }); return Promise.resolve(true); },
    getMessages: () => Promise.resolve([
      { from: "user", content: "here is my product https://lauravita.com/products/anita10" },
      { from: "operator", content: "thanks, checking" },
    ]),
    getStorefrontStoreStatus: (_w: string, shop: string) => Promise.resolve(shop === "lauravita.com" ? { watched: true } : null),
  } as unknown as Db;
  const c = conv("s_msg");
  const shop = await resolveShopDomain({ db, crisp: null }, "ws1", "s_msg", c);
  assertEquals(shop, "lauravita.com");
  assertEquals(merges, [{ patch: { shopify_domain: "lauravita.com" } }]);
  assertEquals(c.custom_data?.shopify_domain, "lauravita.com");
});

Deno.test("resolve shop: link khách gửi nhưng SW KHÔNG theo dõi → không bắt bừa, trả rỗng", async () => {
  const db = {
    mergeConversationCustomData: () => Promise.resolve(true),
    getMessages: () => Promise.resolve([{ from: "user", content: "https://random-store.com/products/1" }]),
    getStorefrontStoreStatus: () => Promise.resolve({ watched: false }),
  } as unknown as Db;
  const shop = await resolveShopDomain({ db, crisp: null }, "ws1", "s_msg_no", conv("s_msg_no"));
  assertEquals(shop, "");
});
