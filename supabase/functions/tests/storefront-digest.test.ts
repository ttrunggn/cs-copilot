import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createOperatorMailer,
  operatorMailerFromEnv,
  type OperatorMailer,
} from "../_shared/crisp-operators.ts";
import type { StorefrontFinding, StorefrontMcp, StorefrontStore } from "../_shared/storefront.ts";
import {
  buildDigestMessage,
  countFindingGroups,
  DIGEST_SUBJECT,
  handleStorefrontDigest,
  runStorefrontDigest,
} from "../copilot/storefront-digest.ts";
import { makeDeps, WS } from "./fakes.ts";

const WS_ID = WS.website_id;

// ---------- fake stateful ----------

interface FakeShop {
  store: StorefrontStore;
  findings: StorefrontFinding[];
  failFind?: boolean;
  failList?: boolean;
}

function store(lastCheckedAt: string | null, watched = true): StorefrontStore {
  return { watched, shop: null, lastCheckedAt, openBySeverity: {}, uncheckedPages: [] };
}

function finding(fingerprint: string, kind?: string, page?: string, extra: Partial<StorefrontFinding> = {}): StorefrontFinding {
  return {
    fingerprint,
    severity: "high",
    locale: "en",
    page: page ?? null,
    text: null,
    kind: kind ?? null,
    widthPx: 1440,
    ...extra,
  } as StorefrontFinding;
}

function makeWorld(shops: Record<string, FakeShop>, opts: { sessions?: Record<string, string | null>; mailerFails?: boolean } = {}) {
  const state = new Map<string, string | null>();
  const known = new Map<string, Set<string>>();
  const listCalls: string[] = [];
  const sent: { websiteId: string; subject: string; message: string }[] = [];
  const { deps } = makeDeps({
    db: {
      getWorkspace: () => Promise.resolve({ ...WS, storefront_watch: true }),
      getRecentShopDomains: () => Promise.resolve(Object.keys(shops)),
      getDigestState: (_w: string, shop: string) =>
        Promise.resolve(state.has(shop) ? { last_good_check: state.get(shop) ?? null } : null),
      setDigestState: (_w: string, shop: string, v: string | null) => {
        state.set(shop, v);
        return Promise.resolve();
      },
      getDigestFindings: (_w: string, shop: string) => Promise.resolve([...(known.get(shop) ?? [])]),
      addDigestFindings: (_w: string, shop: string, fps: string[]) => {
        const s = known.get(shop) ?? new Set<string>();
        fps.forEach((f) => s.add(f));
        known.set(shop, s);
        return Promise.resolve();
      },
      getLatestSessionForShop: (_w: string, shop: string) => Promise.resolve(opts.sessions?.[shop] ?? null),
    },
  });
  const storefront: StorefrontMcp = {
    findStore: (_w: string, shop: string) => {
      const s = shops[shop];
      if (!s || s.failFind) return Promise.reject(new Error("find_store lỗi"));
      return Promise.resolve(s.store);
    },
    listFindings: (_w: string, shop: string) => {
      listCalls.push(shop);
      const s = shops[shop];
      if (!s || s.failList) return Promise.reject(new Error("list_findings lỗi"));
      return Promise.resolve(s.findings);
    },
    getFinding: () => Promise.reject(new Error("unused")),
    acknowledgeFinding: () => Promise.reject(new Error("unused")),
    markFixed: () => Promise.reject(new Error("unused")),
    dismissFinding: () => Promise.reject(new Error("unused")),
    undoFinding: () => Promise.reject(new Error("unused")),
  } as unknown as StorefrontMcp;
  const mailer: OperatorMailer = {
    sendOperatorEmail: (websiteId: string, input: { subject: string; message: string }) => {
      if (opts.mailerFails) return Promise.reject(new Error("Crisp API POST operators/email lỗi (HTTP 403)"));
      sent.push({ websiteId, ...input });
      return Promise.resolve();
    },
  };
  return { db: deps.db, storefront, mailer, state, known, listCalls, sent };
}

// ---------- hàm thuần ----------

Deno.test("buildDigestMessage: mỗi store một khối domain + số lỗi + Crisp + Console; thiếu session thì bỏ dòng Crisp", () => {
  const msg = buildDigestMessage([
    { shop: "a.com", newCount: 3, crispUrl: "https://app.crisp.chat/website/w/inbox/s1", consoleUrl: "https://sw.transcy.io/#/f/x" },
    { shop: "b.com", newCount: 1, crispUrl: null, consoleUrl: "https://sw.transcy.io" },
  ]);
  assertEquals(
    msg,
    [
      "shopify_domain: a.com",
      "3 lỗi mới",
      "Crisp: https://app.crisp.chat/website/w/inbox/s1",
      "Console: https://sw.transcy.io/#/f/x",
      "",
      "shopify_domain: b.com",
      "1 lỗi mới",
      "Console: https://sw.transcy.io",
    ].join("\n"),
  );
});

Deno.test("countFindingGroups: cùng kind+page khác locale tính 1; thiếu kind/page đứng riêng", () => {
  const fs = [
    finding("f1", "Region missing", "/products/x", { locale: "en" }),
    finding("f2", "Region missing", "/products/x", { locale: "de" }),
    finding("f3", "Region missing", "/products/y"),
    finding("f4"),
    finding("f5"),
  ];
  assertEquals(countFindingGroups(fs), 4);
  assertEquals(countFindingGroups([]), 0);
});

// ---------- luồng job ----------

Deno.test("digest lần đầu: chỉ ghi nền (seed), không gửi email", async () => {
  const w = makeWorld({
    "a.com": { store: store("2026-10-26"), findings: [finding("f1"), finding("f2")] },
  });
  const r = await runStorefrontDigest({ db: w.db, storefront: w.storefront, mailer: w.mailer }, WS_ID);
  assertEquals(r.seeded, 1);
  assertEquals(r.emailed, false);
  assertEquals(w.sent.length, 0);
  assertEquals(w.state.get("a.com"), "2026-10-26");
  assertEquals([...(w.known.get("a.com") ?? [])].sort(), ["f1", "f2"]);
});

Deno.test("digest mốc không đổi: bỏ qua, không gọi list_findings, không email", async () => {
  const w = makeWorld({
    "a.com": { store: store("2026-10-26"), findings: [finding("f9")] },
  });
  w.state.set("a.com", "2026-10-26");
  w.known.set("a.com", new Set(["f1"]));
  const r = await runStorefrontDigest({ db: w.db, storefront: w.storefront, mailer: w.mailer }, WS_ID);
  assertEquals(r.changed, 0);
  assertEquals(w.listCalls.length, 0);
  assertEquals(w.sent.length, 0);
});

Deno.test("digest đợt quét mới nhưng không có bug mới: nâng mốc lặng lẽ, không email", async () => {
  const w = makeWorld({
    "a.com": { store: store("2026-10-27"), findings: [finding("f1")] },
  });
  w.state.set("a.com", "2026-10-26");
  w.known.set("a.com", new Set(["f1"]));
  const r = await runStorefrontDigest({ db: w.db, storefront: w.storefront, mailer: w.mailer }, WS_ID);
  assertEquals(r.changed, 1);
  assertEquals(r.emailed, false);
  assertEquals(w.state.get("a.com"), "2026-10-27");
});

Deno.test("digest có bug mới ở 2 store: gửi đúng 1 email đúng format, nâng mốc sau khi gửi; chạy lại không gửi trùng", async () => {
  const shops: Record<string, FakeShop> = {
    "a.com": {
      store: store("2026-10-27"),
      findings: [
        finding("old1"),
        finding("n1", "Region missing", "/p", { locale: "en" }),
        finding("n2", "Region missing", "/p", { locale: "de" }),
      ],
    },
    "b.com": {
      store: store("2026-10-27"),
      findings: [finding("n3", "Text overflow", "/home"), finding("n4", "Region missing", "/cart")],
    },
  };
  const w = makeWorld(shops, { sessions: { "a.com": "sess-a" } });
  w.state.set("a.com", "2026-10-26");
  w.known.set("a.com", new Set(["old1"]));
  w.state.set("b.com", "2026-10-26");
  const r = await runStorefrontDigest({ db: w.db, storefront: w.storefront, mailer: w.mailer }, WS_ID);
  assertEquals(r.emailed, true);
  assertEquals(r.reported, 2);
  assertEquals(w.sent.length, 1);
  assertEquals(w.sent[0].subject, DIGEST_SUBJECT);
  assertEquals(w.sent[0].subject, "Storefront Watch Weekly Scan");
  const body = w.sent[0].message;
  assert(body.includes("shopify_domain: a.com"));
  // a.com: n1+n2 trùng căn nguyên (cùng kind+page, khác locale) -> 1 lỗi; b.com: 2 lỗi khác nhau -> 2 lỗi
  assert(body.includes("1 lỗi mới"));
  assert(body.includes("2 lỗi mới"));
  assert(body.includes(`Crisp: https://app.crisp.chat/website/${WS_ID}/inbox/sess-a`));
  assert(body.includes("shopify_domain: b.com"));
  assert(body.includes("Console: https://sw.transcy.io/#/f/"));
  // mốc đã nâng + fingerprint mới đã ghi
  assertEquals(w.state.get("a.com"), "2026-10-27");
  assert(w.known.get("a.com")?.has("n1"));
  // chạy lại cùng dữ kiện: không gửi nữa
  const r2 = await runStorefrontDigest({ db: w.db, storefront: w.storefront, mailer: w.mailer }, WS_ID);
  assertEquals(r2.emailed, false);
  assertEquals(w.sent.length, 1);
});

Deno.test("digest gửi email lỗi: không nâng mốc, không ghi fingerprint; lần sau gửi lại được", async () => {
  const shops: Record<string, FakeShop> = {
    "a.com": { store: store("2026-10-27"), findings: [finding("n1")] },
  };
  const w = makeWorld(shops, { mailerFails: true });
  w.state.set("a.com", "2026-10-26");
  const r = await runStorefrontDigest({ db: w.db, storefront: w.storefront, mailer: w.mailer }, WS_ID);
  assertEquals(r.emailed, false);
  assert(r.email_error?.includes("403"));
  assertEquals(w.state.get("a.com"), "2026-10-26");
  assertEquals(w.known.get("a.com")?.size ?? 0, 0);
});

Deno.test("digest một store lỗi find_store: failed=1, store còn lại vẫn được báo", async () => {
  const shops: Record<string, FakeShop> = {
    "bad.com": { store: store("2026-10-27"), findings: [], failFind: true },
    "a.com": { store: store("2026-10-27"), findings: [finding("n1")] },
  };
  const w = makeWorld(shops);
  w.state.set("a.com", "2026-10-26");
  const r = await runStorefrontDigest({ db: w.db, storefront: w.storefront, mailer: w.mailer }, WS_ID);
  assertEquals(r.failed, 1);
  assertEquals(r.emailed, true);
  assertEquals(w.sent.length, 1);
});

Deno.test("digest cổng workspace/mailer: không bật storefront_watch -> not_transcy_workspace; thiếu mailer -> mail_unconfigured", async () => {
  const w = makeWorld({ "a.com": { store: store("2026-10-27"), findings: [] } });
  const { deps } = makeDeps({ db: { getWorkspace: () => Promise.resolve({ ...WS, storefront_watch: false }) } });
  const r1 = await runStorefrontDigest({ db: deps.db, storefront: w.storefront, mailer: w.mailer }, WS_ID);
  assertEquals(r1.skipped, "not_transcy_workspace");
  const r2 = await runStorefrontDigest({ db: w.db, storefront: w.storefront, mailer: null }, WS_ID);
  assertEquals(r2.skipped, "mail_unconfigured");
});

Deno.test("handleStorefrontDigest: thiếu website_id -> 400", async () => {
  const w = makeWorld({});
  const r = await handleStorefrontDigest({}, { db: w.db, storefront: w.storefront, mailer: w.mailer });
  assertEquals(r.status, 400);
});

// ---------- mailer Crisp ----------

function fakeFetch(responder: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = ((input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(responder(String(input), init ?? {}));
  }) as typeof fetch;
  return { f, calls };
}
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.test("operator mailer: POST đúng URL/body recipient=all + auth Basic + tier plugin; HTTP lỗi ném CrispError", async () => {
  const { f, calls } = fakeFetch(() => jsonRes({ error: false, data: {} }));
  const m = createOperatorMailer({ identifier: "id-x", key: "key-y", fetch: f });
  await m.sendOperatorEmail("ws1", { subject: "Storefront Watch Weekly Scan", message: "shopify_domain: a.com" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.crisp.chat/v1/website/ws1/operators/email");
  assertEquals(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers["authorization"], `Basic ${btoa("id-x:key-y")}`);
  assertEquals(headers["x-crisp-tier"], "plugin");
  assertEquals(JSON.parse(String(calls[0].init.body)), {
    recipient: "all",
    subject: "Storefront Watch Weekly Scan",
    message: "shopify_domain: a.com",
  });
  const bad = fakeFetch(() => jsonRes({ error: true, reason: "invalid_scope" }, 403));
  const m2 = createOperatorMailer({ identifier: "id-x", key: "key-y", fetch: bad.f });
  let threw = false;
  try {
    await m2.sendOperatorEmail("ws1", { subject: "s", message: "m" });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("operatorMailerFromEnv: thiếu credential -> null", () => {
  assertEquals(operatorMailerFromEnv(() => undefined), null);
  assert(operatorMailerFromEnv((k) => k === "CRISP_PLUGIN_IDENTIFIER" ? "id" : "key") !== null);
});
