import { assertEquals } from "jsr:@std/assert@1";
import { countPlaceholders, describeShape, handoffStatus, insertResultMessage, mapError, operatorIdFrom, readContext, timeAgo, toDraftViewModel, toStorefrontViewModel, toViewModel } from "./core.js";

const NOW = Date.parse("2026-10-16T10:00:00Z");

const TOKEN = "11111111-2222-3333-4444-555555555555";

Deno.test("reads website_id, session_id and Crisp website token from iframe URL", () => {
  assertEquals(readContext(`?website_id=f5733b35-0234&session_id=session_abc-1&token=${TOKEN}&locale=en`),
    { websiteId: "f5733b35-0234", sessionId: "session_abc-1", crispToken: TOKEN });
});

Deno.test("missing Crisp token means the page was not opened by Crisp", () => {
  assertEquals(readContext("?website_id=ws1&session_id=session_1"), { error: "Mở copilot từ sidebar của Crisp" });
});

Deno.test("missing session_id asks to open a conversation", () => {
  assertEquals(readContext(`?website_id=ws1&token=${TOKEN}`), { error: "Mở một conversation để dùng copilot" });
});

Deno.test("malformed ids are rejected", () => {
  assertEquals(readContext(`?website_id=ws1&session_id=../x&token=${TOKEN}`), { error: "Mở một conversation để dùng copilot" });
});

Deno.test("401 → fatal with server message (no token form anymore)", () => {
  assertEquals(mapError(401, { error: "Widget không hợp lệ cho workspace này" }), { kind: "fatal", message: "Widget không hợp lệ cho workspace này" });
});

Deno.test("403 → forbidden with server message", () => {
  assertEquals(mapError(403, { error: "CS không thuộc workspace này" }), { kind: "forbidden", message: "CS không thuộc workspace này" });
});

Deno.test("404 → retry", () => {
  assertEquals(mapError(404, {}).kind, "retry");
});

Deno.test("500 / network → fatal", () => {
  assertEquals(mapError(500, {}).kind, "fatal");
  assertEquals(mapError(0, {}).kind, "fatal");
});

Deno.test("timeAgo formats minutes, hours, days", () => {
  assertEquals(timeAgo("2026-10-16T09:58:00Z", NOW), "2 phút trước");
  assertEquals(timeAgo("2026-10-16T07:00:00Z", NOW), "3 giờ trước");
  assertEquals(timeAgo("2026-10-14T10:00:00Z", NOW), "2 ngày trước");
  assertEquals(timeAgo("2026-10-16T09:59:50Z", NOW), "vừa xong");
  assertEquals(timeAgo(null, NOW), "—");
});

const CHECK = {
  action: "check", stale: false, workspace: "Transcy", topic: "billing", topic_label: "Billing",
  profile_source: "topic", profile_name: "Lan Nguyen", needs_reply: true,
  unanswered: ["a", "b", "c", "d"], last_customer_at: "2026-10-16T09:58:00Z", last_human_operator_at: null, jira: [],
};

Deno.test("view model shows last 3 unanswered, newest last", () => {
  const vm = toViewModel(CHECK, NOW);
  assertEquals(vm.needsReply, true);
  assertEquals(vm.unanswered, ["b", "c", "d"]);
  assertEquals(vm.header, "4 tin khách đang chờ");
});

Deno.test("view model meta lines", () => {
  assertEquals(toViewModel(CHECK, NOW).meta, [
    "Topic: Billing",
    "Giọng văn: Lan Nguyen (theo topic)",
    "Khách nhắn: 2 phút trước · CS trả lời: —",
  ]);
});

Deno.test("view model when nothing pending", () => {
  const vm = toViewModel({ ...CHECK, needs_reply: false, unanswered: [], topic: null, topic_label: null, profile_source: "default" }, NOW);
  assertEquals(vm.header, "Không có tin chờ");
  assertEquals(vm.meta[0], "Topic: chưa xác định");
  assertEquals(vm.meta[1], "Giọng văn: Lan Nguyen (mặc định workspace)");
});

Deno.test("escapes and truncates long customer messages", () => {
  const long = "<b>x</b>" + "y".repeat(400);
  const vm = toViewModel({ ...CHECK, unanswered: [long] }, NOW);
  assertEquals(vm.unanswered[0].length, 301);
  assertEquals(vm.unanswered[0].startsWith("<b>x</b>"), true); // render bằng textContent, không parse HTML
});

Deno.test("stale flag passes through", () => {
  assertEquals(toViewModel({ ...CHECK, stale: true }, NOW).stale, true);
});

Deno.test("operatorIdFrom handles the shapes Crisp may return", () => {
  assertEquals(operatorIdFrom({ user_id: "u1" }), "u1");
  assertEquals(operatorIdFrom({ operator: { user_id: "u2" } }), "u2");
  assertEquals(operatorIdFrom({ data: { user_id: "u3" } }), "u3");
  assertEquals(operatorIdFrom({ details: { user_id: "u4" } }), "u4");
  // Cấu trúc thực tế trong Crisp (đo trên Transcy): data{operator}
  assertEquals(operatorIdFrom({ data: { operator: { user_id: "u5" } } }), "u5");
  assertEquals(operatorIdFrom({ email: "x@y" }), "");
  assertEquals(operatorIdFrom(undefined), "");
});

Deno.test("describeShape lists field names only, never values", () => {
  assertEquals(describeShape({ email: "secret@x", operator: { first_name: "Lan" } }), "email, operator{first_name}");
  assertEquals(describeShape(null), "(trống)");
});

Deno.test("mapError 503 AI_UNAVAILABLE → retry with quota message", () => {
  assertEquals(mapError(503, { code: "AI_UNAVAILABLE", error: "x" }), { kind: "retry", message: "AI đang hết quota hoặc lỗi, thử lại sau" });
});

Deno.test("toDraftViewModel badges for verified/unverified/no helpdesk", () => {
  const base = { draft: "Hi", warnings: [], verified: true, helpdesk_matches: 2 };
  assertEquals(toDraftViewModel(base).badge, "✓ 2 ý có nguồn helpdesk");
  assertEquals(toDraftViewModel({ ...base, verified: false }).badge, "Chưa đối chiếu helpdesk");
  assertEquals(toDraftViewModel({ ...base, helpdesk_matches: 0 }).badge, "Không có bài helpdesk liên quan");
});

Deno.test("toDraftViewModel badge đếm theo sources thật, bỏ link không phải https", () => {
  const vm = toDraftViewModel({
    draft: "Hi", warnings: [], verified: true, helpdesk_matches: 9,
    sources: [
      { title: "Bài A", url: "https://help.transcy.io/a" },
      { title: "Bài B", url: "https://help.transcy.io/b" },
      { title: "Xấu", url: "javascript:alert(1)" },
    ],
  });
  assertEquals(vm.badge, "✓ 2 ý có nguồn helpdesk");
  assertEquals(vm.sources, [
    { title: "Bài A", url: "https://help.transcy.io/a" },
    { title: "Bài B", url: "https://help.transcy.io/b" },
  ]);
});

Deno.test("countPlaceholders đếm các chỗ [[CS: …]]", () => {
  assertEquals(countPlaceholders("A [[CS: kiểm tra gói]] B [[CS: link]]"), 2);
  assertEquals(countPlaceholders("không có chỗ trống"), 0);
  assertEquals(countPlaceholders(""), 0);
  assertEquals(countPlaceholders(null), 0);
});

Deno.test("toDraftViewModel accepts latest_draft shape and maps warnings", () => {
  const vm = toDraftViewModel({ content: "Hello", warnings: [{ claim: "c", reason: "r", article_url: "https://h/a" }], verified: null });
  assertEquals(vm.text, "Hello");
  assertEquals(vm.warnings, [{ claim: "c", reason: "r", url: "https://h/a" }]);
  assertEquals(vm.badge, "Chưa đối chiếu helpdesk");
});

Deno.test("toDraftViewModel counts [[CS]] todos", () => {
  assertEquals(toDraftViewModel({ draft: "A [[CS: kiểm tra gói]] B [[CS: link]]", warnings: [], verified: true, helpdesk_matches: 1 }).todos, 2);
});

Deno.test("toDraftViewModel drops non-https warning links", () => {
  const vm = toDraftViewModel({ draft: "x", warnings: [{ claim: "c", reason: "r", article_url: "javascript:alert(1)" }], verified: true, helpdesk_matches: 1 });
  assertEquals(vm.warnings[0].url, null);
});

Deno.test("insertResultMessage covers the 5 statuses", () => {
  for (const s of ["inserted", "session_mismatch", "not_empty", "duplicate", "composer_not_found"]) {
    assertEquals(typeof insertResultMessage(s), "string", s);
    assertEquals(insertResultMessage(s).length > 0, true, s);
  }
  assertEquals(insertResultMessage("session_mismatch"), "Draft của chat khác đã sẵn sàng, mở lại đúng chat để điền");
});

Deno.test("reloaded latest_draft without helpdesk match keeps the no-article badge", () => {
  assertEquals(toDraftViewModel({ content: "x", warnings: [], verified: true, helpdesk_matches: 0 }).badge, "Không có bài helpdesk liên quan");
});

Deno.test("handoffStatus says already posted only when it really was", () => {
  assertEquals(handoffStatus({ cached: true, posted: true }), "Note này đã đăng trước đó");
  assertEquals(handoffStatus({ cached: true, posted: false }), "Chưa đăng được note, copy giúp");
  assertEquals(handoffStatus({ cached: false, posted: true }), "Đã đăng private note");
  assertEquals(handoffStatus({ cached: false, posted: false }), "Chưa đăng được note, copy giúp");
});

Deno.test("mapError 503 AI_BAD_OUTPUT → retry with server message", () => {
  assertEquals(mapError(503, { code: "AI_BAD_OUTPUT", error: "AI trả kết quả không dùng được, bấm lại thử" }), { kind: "retry", message: "AI trả kết quả không dùng được, bấm lại thử" });
});

Deno.test("toDraftViewModel shows how old the draft is", () => {
  const vm = toDraftViewModel({ content: "x", warnings: [], verified: true, helpdesk_matches: 1, created_at: "2026-10-16T09:50:00Z" }, NOW);
  assertEquals(vm.age, "10 phút trước");
});

Deno.test("toViewModel exposes topic label and conversation state for chips/CSAT gating", () => {
  const vm = toViewModel({ ...CHECK, conversation_state: "resolved" }, NOW);
  assertEquals(vm.topicLabel, "Billing");
  assertEquals(vm.conversationState, "resolved");
  assertEquals(toViewModel({ ...CHECK, topic: null, topic_label: null }, NOW).topicLabel, null);
  assertEquals(toViewModel(CHECK, NOW).conversationState, null);
});

Deno.test("toStorefrontViewModel: chưa nối nguồn → empty; loading/error/missing-domain tách riêng", () => {
  assertEquals(toStorefrontViewModel(null, NOW), { kind: "empty" });
  assertEquals(toStorefrontViewModel({ status: "loading" }, NOW), { kind: "loading" });
  assertEquals(toStorefrontViewModel({ status: "error" }, NOW), { kind: "error" });
  assertEquals(toStorefrontViewModel({ status: "ok", store: null }, NOW), { kind: "missing-domain" });
});

Deno.test("toStorefrontViewModel: results gom lỗi đã xác nhận + tín hiệu chưa xác minh + cờ cũ", () => {
  const vm = toStorefrontViewModel({
    status: "ok",
    store: "store-abc.myshopify.com",
    scannedAt: "2026-10-16T09:00:00Z",
    isStale: true,
    confirmed: [
      { level: "critical", title: "Lộ mã template (thẻ <tc>) trên trang", meta: "ko-kr · thấy 2 lần · nên gửi dev" },
      { level: "new", title: "Mất hình", meta: "fr-fr · đã xác nhận" },
    ],
    unverified: [{ title: "Chiều cao trang nhảy", meta: "fr-fr · cần xác minh" }],
  }, NOW);
  assertEquals(vm.kind, "results");
  assertEquals(vm.confirmedCount, 2);
  assertEquals(vm.unverifiedCount, 1);
  assertEquals(vm.isStale, true);
  assertEquals(vm.scannedLabel, "1 giờ trước");
  assertEquals(vm.confirmed[0].chip, "Nghiêm trọng");
  assertEquals(vm.confirmed[0].chipClass, "critical");
  assertEquals(vm.confirmed[1].chip, "Mới");
});

Deno.test("toJiraViewModel shows status, NEW badge and the latest new comment", async () => {
  const { toJiraViewModel } = await import("./core.js");
  const vm = toJiraViewModel([{
    issue_key: "TNT-1", url: "https://firegroup.atlassian.net/browse/TNT-1", summary: "Menu bug", status: "Pending Dev",
    is_new: true, status_changed: true, new_comments: [{ author: "Dev Minh", role: "tech", body: "Fixed", created_at: "2026-10-16T09:00:00Z" }], recent_comments: [],
  }, { issue_key: "TNT-2", url: "javascript:alert(1)", summary: null, status: null, is_new: false, status_changed: false, new_comments: [], recent_comments: [] }], NOW);
  assertEquals(vm[0], { key: "TNT-1", url: "https://firegroup.atlassian.net/browse/TNT-1", title: "TNT-1 · Pending Dev", summary: "Menu bug", isNew: true, news: ["Đổi trạng thái", "Tech · Dev Minh (1 giờ trước): Fixed"] });
  assertEquals(vm[1].url, null);
  assertEquals(vm[1].title, "TNT-2 · chưa đồng bộ");
});
