import { assert, assertEquals } from "jsr:@std/assert@1";
import { resetSessionScopedState } from "./state.js";

// Trục cách ly giữa các chat phía widget: `state` là bộ nhớ dùng chung duy
// nhất của panel, nên khi đổi conversation mọi dữ liệu của chat cũ phải bị
// quên — đặc biệt shop của module Storefront (shop đã resolve từ custom data
// hoặc CS nhập tay cho chat trước tuyệt đối không được dùng cho chat sau).
// app.js thực hiện việc quên này bằng resetSessionScopedState(state) tại
// đúng nhánh đổi session của load(); các test dưới khoá cả hành vi của hàm
// lẫn việc app.js thật sự gọi nó.

/** Một state "bẩn" chứa đầy dữ liệu của chat A + trạng thái của CS/extension. */
function dirtyState() {
  return {
    operatorId: "op-lan",
    operatorName: "Test Agent",
    tone: "friendly",
    bridge: "ready",
    bridgeProbe: null,
    check: { jira: [{ issue_key: "TNT-1" }], sentiment: { mood: "frustrated" } },
    draft: { output_id: 42, session_id: "session_A", vm: { text: "draft của A" } },
    shownSession: "session_A",
    handoff: { note: "note của A", cached: false },
    noteInsertId: "note-x",
    notePlacement: "inserted",
    notice: "lỗi của A",
    noticeKind: "error",
    choice: true,
    choiceFor: "note",
    draftPlacement: "inserted",
    modal: "note",
    composeOpen: false,
    csatChoice: "review",
    reviewText: "review của A",
    reviewInsertId: "review-x",
    askQuestion: "câu hỏi của A",
    askResult: { question: "câu hỏi của A", found: true, answer: "đáp án A", sources: [] },
    sentiment: { mood: "frustrated", score: 20 },
    sentimentMsgCount: 5,
    sentimentRefreshing: true,
    csat: { sent: true, sent_at: "2026-10-23T00:00:00Z" },
    csatError: true,
    csatErrorMsg: "lỗi gửi của A",
    hint: "ý của A",
    storefront: { status: "ok", store: "shop-a.myshopify.com" },
    storefrontShop: "shop-a.myshopify.com",
    storefrontShopInput: "shop-a.myshopify.com",
    storefrontDetail: { fingerprint: "a".repeat(40) },
    storefrontDetailLoading: "a".repeat(40),
    unlinkConfirm: "TNT-1",
  };
}

Deno.test("resetSessionScopedState: quên sạch dữ liệu chat cũ — draft, sentiment, CSAT, handoff, ask, Jira (check) và shop Storefront", () => {
  const s = resetSessionScopedState(dirtyState());
  assertEquals(s.draft, null);
  assertEquals(s.sentiment, null);
  assertEquals(s.sentimentMsgCount, 0);
  assertEquals(s.sentimentRefreshing, false);
  assertEquals(s.csat, null);
  assertEquals(s.csatError, false);
  assertEquals(s.csatErrorMsg, "");
  assertEquals(s.handoff, null);
  assertEquals(s.modal, null);
  assertEquals(s.csatChoice, "");
  assertEquals(s.reviewText, "");
  assertEquals(s.reviewInsertId, "");
  assertEquals(s.composeOpen, true);
  assertEquals(s.askQuestion, "");
  assertEquals(s.askResult, null);
  assertEquals(s.choice, false);
  assertEquals(s.choiceFor, "draft");
  assertEquals(s.unlinkConfirm, "");
  assertEquals(s.check, null); // Jira/issues/sentiment của panel đều suy từ check → mất theo
  assertEquals(s.draftPlacement, "");
  assertEquals(s.hint, "");
  assertEquals(s.notice, "");
  assertEquals(s.noteInsertId, "");
  assertEquals(s.notePlacement, "");
  // Storefront: shop đã resolve + chữ đang gõ + chi tiết finding đều quên.
  assertEquals(s.storefront, null);
  assertEquals(s.storefrontShop, "");
  assertEquals(s.storefrontShopInput, "");
  assertEquals(s.storefrontDetail, null);
  assertEquals(s.storefrontDetailLoading, "");
  assert(!JSON.stringify(s).includes("shop-a.myshopify.com"), "không còn dấu vết shop của chat cũ");
});

Deno.test("resetSessionScopedState: giữ nguyên trạng thái thuộc về CS/extension, không thuộc về chat", () => {
  const s = resetSessionScopedState(dirtyState());
  assertEquals(s.operatorId, "op-lan");
  assertEquals(s.operatorName, "Test Agent");
  assertEquals(s.tone, "friendly"); // lựa chọn giọng văn của CS, không phải dữ liệu khách
  assertEquals(s.bridge, "ready");
});

Deno.test("đổi chat A → B → A: mỗi lần đổi, shop của chat vừa rời không lọt sang chat mới", () => {
  const s = dirtyState(); // đang ở A với shop-a
  resetSessionScopedState(s);
  assertEquals(s.storefrontShop, "");
  // Chat B resolve/nhập shop riêng của nó…
  s.storefrontShop = "shop-b.myshopify.com";
  s.storefrontShopInput = "shop-b.myshopify.com";
  s.check = { jira: [] };
  // …rồi đổi tiếp sang chat khác: shop B cũng phải bị quên như shop A.
  resetSessionScopedState(s);
  assertEquals(s.storefrontShop, "");
  assertEquals(s.storefrontShopInput, "");
  assertEquals(s.check, null);
  assert(!JSON.stringify(s).includes("shop-b.myshopify.com"));
});

const appSource = await Deno.readTextFile(new URL("./app.js", import.meta.url));

Deno.test("app.js: nhánh đổi session của load() gọi resetSessionScopedState(state) trước khi nạp chat mới", () => {
  const branch = appSource.slice(appSource.indexOf("sessionId !== state.shownSession"));
  assert(branch.includes("resetSessionScopedState(state)"), "load() phải reset qua hàm đã test khi session thay đổi");
});

Deno.test("app.js: cache check (SWR) khoá theo session_id — get/set đều bằng sessionId của request", () => {
  assert(appSource.includes("const checkCache = new Map()"));
  assert(appSource.includes("checkCache.get(sessionId)"), "đọc cache phải theo session đang mở");
  assert(appSource.includes("checkCache.set(sessionId, state.check)"), "ghi cache phải theo session vừa check");
});

Deno.test("app.js: call() có stale-guard — response về sau khi đã đổi chat bị bỏ, không ghi đè state của chat mới", () => {
  assert(
    appSource.includes("readContext(location.search).sessionId !== ctx.sessionId"),
    "call() phải so session hiện tại với session lúc gửi request",
  );
  assert(appSource.includes("stale: true"), "response lệch session phải thành stale và bị handler bỏ qua");
});
