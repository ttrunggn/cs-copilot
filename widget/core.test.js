import { assertEquals } from "jsr:@std/assert@1";
import { actionButtonState, askAnswerToHint, enabledModules, explanationTemplate, previewNeedsToggle, countPlaceholders, describeShape, handoffStatus, insertResultMessage, mapError, operatorIdFrom, operatorNameFrom, PROGRESS_STEPS, progressStepIndex, readContext, REVIEW_TEMPLATE, timeAgo, toAskViewModel, toDraftViewModel, toIssuesViewModel, toJiraViewModel, toStorefrontViewModel, toViewModel } from "./core.js";

const NOW = Date.parse("2026-10-16T10:00:00Z");

const TOKEN = "11111111-2222-3333-4444-555555555555";

Deno.test("actionButtonState: rảnh thì nút action bật, không chạy", () => {
  assertEquals(actionButtonState("", "generate"), { running: false, disabled: false });
});

Deno.test("actionButtonState: nút của action đang chạy hiện running và bị khoá", () => {
  assertEquals(actionButtonState("generate", "generate"), { running: true, disabled: true });
});

Deno.test("actionButtonState: action khác đang chạy thì nút bị khoá nhưng không running (không spinner)", () => {
  assertEquals(actionButtonState("analyze", "generate"), { running: false, disabled: true });
  assertEquals(actionButtonState("ask", "survey"), { running: false, disabled: true });
});

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
  profile_source: "topic", profile_name: "Test Agent", needs_reply: true,
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
    "Giọng văn: Test Agent (theo topic)",
    "Khách nhắn: 2 phút trước · CS trả lời: —",
  ]);
});

Deno.test("view model when nothing pending", () => {
  const vm = toViewModel({ ...CHECK, needs_reply: false, unanswered: [], topic: null, topic_label: null, profile_source: "default" }, NOW);
  assertEquals(vm.header, "Không có tin chờ");
  assertEquals(vm.meta[0], "Topic: chưa xác định");
  assertEquals(vm.meta[1], "Giọng văn: Test Agent (mặc định workspace)");
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

Deno.test("operatorNameFrom reads the account name from the shapes Crisp may return", () => {
  assertEquals(operatorNameFrom({ data: { operator: { user_id: "u5", first_name: "Test", last_name: "Agent" } } }), "Test Agent");
  assertEquals(operatorNameFrom({ operator: { name: "Test Agent" } }), "Test Agent");
  assertEquals(operatorNameFrom({ details: { first_name: "Test", last_name: "Agent" } }), "Test Agent");
  assertEquals(operatorNameFrom({ nickname: "Tester" }), "Tester");
  assertEquals(operatorNameFrom({ user_id: "u1" }), "");
  assertEquals(operatorNameFrom(undefined), "");
});

Deno.test("describeShape lists field names only, never values", () => {
  assertEquals(describeShape({ email: "secret@x", operator: { first_name: "Test" } }), "email, operator{first_name}");
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

Deno.test("insertResultMessage covers the reply statuses incl. note_unconfirmed fallback", () => {
  for (const s of ["inserted", "session_mismatch", "not_empty", "duplicate", "composer_not_found", "note_unconfirmed"]) {
    assertEquals(typeof insertResultMessage(s), "string", s);
    assertEquals(insertResultMessage(s).length > 0, true, s);
  }
  assertEquals(insertResultMessage("session_mismatch"), "Draft của chat khác đã sẵn sàng, mở lại đúng chat để điền");
  // Không còn đường Copy nữa: composer_not_found không được nhắc tới Copy/Ctrl+V.
  assertEquals(insertResultMessage("composer_not_found").includes("Copy"), false);
});

Deno.test("insertResultMessage with note target speaks about the Note box", () => {
  assertEquals(insertResultMessage("inserted", "note"), "Đã điền note vào ô Note, sửa lại rồi tự đăng trong Crisp");
  assertEquals(insertResultMessage("not_empty", "note"), "Ô Note đang có chữ");
  assertEquals(insertResultMessage("duplicate", "note"), "Note này đã được điền rồi");
  // Status an toàn của riêng note: extension không xác nhận được Note mode → không điền gì cả.
  assertEquals(insertResultMessage("note_unconfirmed", "note").includes("chưa điền gì cả"), true);
  assertEquals(insertResultMessage("session_mismatch", "note").includes("Note"), true);
});

Deno.test("reloaded latest_draft without helpdesk match keeps the no-article badge", () => {
  assertEquals(toDraftViewModel({ content: "x", warnings: [], verified: true, helpdesk_matches: 0 }).badge, "Không có bài helpdesk liên quan");
});

Deno.test("handoffStatus never claims the note was posted — copilot does not post notes", () => {
  assertEquals(handoffStatus({ cached: true }), "Note đã tạo trước đó — chưa đăng");
  assertEquals(handoffStatus({ cached: false }), "Note mới — chưa đăng");
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

Deno.test("toStorefrontViewModel: results gom issue theo đúng 3 trạng thái Mới / Đã xác nhận / Đang xử lý", () => {
  const vm = toStorefrontViewModel({
    status: "ok",
    store: "store-abc.myshopify.com",
    scannedAt: "2026-10-16T09:00:00Z",
    isStale: true,
    new: [{ title: "Mất hình ở trang collection", meta: "fr-fr · cập nhật 26 phút trước" }],
    acknowledged: [{ title: "Thiếu vùng nội dung", meta: "ja, zh, es · đã tiếp nhận, sync đợt trước" }],
    inProgress: [{ title: "Webhook thanh toán không bắn", meta: "CS đã liên hệ khách — theo hội thoại này" }],
  }, NOW);
  assertEquals(vm.kind, "results");
  assertEquals(vm.totalCount, 3);
  assertEquals(vm.isStale, true);
  assertEquals(vm.scannedLabel, "1 giờ trước");
  assertEquals(vm.groups.map((g) => [g.status, g.label, g.items.length]), [
    ["new", "Mới", 1],
    ["acknowledged", "Đã xác nhận", 1],
    ["in_progress", "Đang xử lý", 1],
  ]);
  assertEquals(vm.groups[2].items[0].title, "Webhook thanh toán không bắn");
});

Deno.test("toStorefrontViewModel: dữ liệu thô kiểu cũ (confirmed + level) vẫn xếp được vào 3 nhóm, unverified bị bỏ", () => {
  const vm = toStorefrontViewModel({
    status: "ok",
    store: "store-abc.myshopify.com",
    scannedAt: "2026-10-16T09:00:00Z",
    confirmed: [
      { level: "critical", title: "Lộ mã template (thẻ <tc>) trên trang", meta: "ko-kr · thấy 2 lần" },
      { level: "new", title: "Mất hình", meta: "fr-fr" },
    ],
    unverified: [{ title: "Chiều cao trang nhảy", meta: "fr-fr · cần xác minh" }],
  }, NOW);
  assertEquals(vm.kind, "results");
  assertEquals(vm.totalCount, 2);
  assertEquals(vm.groups[0].items.map((i) => i.title), ["Mất hình"]);
  assertEquals(vm.groups[1].items.map((i) => i.title), ["Lộ mã template (thẻ <tc>) trên trang"]);
  assertEquals(vm.groups[2].items, []);
});

Deno.test("toIssuesViewModel: ưu tiên issues (câu tóm tắt + bằng chứng) của sentiment", () => {
  const vm = toIssuesViewModel(CHECK, {
    issues: [
      { summary: "Khách bị trừ phí 2 lần", evidence: "charged me twice" },
      { summary: "Khách chưa rõ thời gian hoàn tiền", evidence: "" },
      { summary: "  ", evidence: "bị bỏ vì summary rỗng" },
    ],
  });
  assertEquals(vm.issues, [
    { title: "Khách bị trừ phí 2 lần", detail: "Khách nhắn: \"charged me twice\"" },
    { title: "Khách chưa rõ thời gian hoàn tiền", detail: null },
  ]);
});

Deno.test("toIssuesViewModel: signals KHÔNG thành issue và KHÔNG có thẻ dự phòng theo topic", () => {
  const vm = toIssuesViewModel(CHECK, { signals: ["human pls", "i just want someone help"] });
  assertEquals(vm.issues, []);
});

Deno.test("toIssuesViewModel: chưa có sentiment/issues thật thì rỗng (không bịa thẻ 'Khác / Chủ đề của hội thoại')", () => {
  assertEquals(toIssuesViewModel(CHECK, null).issues, []);
  assertEquals(toIssuesViewModel({ ...CHECK, topic: null, topic_label: null }, null).issues, []);
  assertEquals(toIssuesViewModel(null, null).issues, []);
  assertEquals(toIssuesViewModel(CHECK, { signals: [] }).issues, []);
});

Deno.test("REVIEW_TEMPLATE là template xin review mặc định có nội dung", () => {
  assertEquals(typeof REVIEW_TEMPLATE, "string");
  assertEquals(REVIEW_TEMPLATE.includes("leave a review"), true);
});

Deno.test("toJiraViewModel shows status, update badge with from → to, and the latest new comment", async () => {
  const { toJiraViewModel } = await import("./core.js");
  const vm = toJiraViewModel([{
    issue_key: "TNT-1", url: "https://firegroup.atlassian.net/browse/TNT-1", summary: "Menu bug", status: "Pending Dev",
    has_update: true, status_changed: true, prev_status: "In Progress", done: false, awaiting_report: false,
    new_comments: [{ author: "Dev A", role: "tech", body: "Fixed", created_at: "2026-10-16T09:00:00Z" }], recent_comments: [],
  }, { issue_key: "TNT-2", url: "javascript:alert(1)", summary: null, status: null, has_update: false, status_changed: false, prev_status: null, done: false, awaiting_report: false, new_comments: [], recent_comments: [] }], NOW);
  assertEquals(vm[0], { key: "TNT-1", url: "https://firegroup.atlassian.net/browse/TNT-1", name: "Menu bug", status: "Pending Dev", done: false, hasUpdate: true, awaitingReport: false, statusLine: "Đổi trạng thái: In Progress → Pending Dev", updatedLabel: "Cập nhật 1 giờ trước", latestTech: { author: "Dev A", ago: "1 giờ trước", body: "Fixed" } });
  assertEquals(vm[1].url, null);
  assertEquals(vm[1].name, "TNT-2");
  assertEquals(vm[1].status, "Chưa đồng bộ");
});

Deno.test("toJiraViewModel: ticket Done chưa báo khách mang cờ awaitingReport; thiếu prev_status thì dòng đổi trạng thái không có 'từ →'", async () => {
  const { toJiraViewModel } = await import("./core.js");
  const vm = toJiraViewModel([{
    issue_key: "TNT-3", url: "https://firegroup.atlassian.net/browse/TNT-3", summary: "Crash", status: "Done",
    has_update: true, status_changed: true, prev_status: null, done: true, awaiting_report: true, new_comments: [], recent_comments: [],
  }], NOW);
  assertEquals(vm[0].awaitingReport, true);
  assertEquals(vm[0].hasUpdate, true);
  assertEquals(vm[0].name, "Crash");
  assertEquals(vm[0].statusLine, "Đổi trạng thái");
});

Deno.test("enabledModules: dùng nguyên kết quả server tính trong check.modules", () => {
  assertEquals(enabledModules({ modules: { jira: true, storefront: true }, jira: [] }), { jira: true, storefront: true });
  assertEquals(enabledModules({ modules: { jira: true, storefront: false }, jira: [{ issue_key: "OES-15" }] }), { jira: true, storefront: false });
  assertEquals(enabledModules({ modules: { jira: false, storefront: false }, jira: [] }), { jira: false, storefront: false });
});

Deno.test("enabledModules: response thiếu modules (server cũ) → Jira theo ticket liên kết, Storefront ẩn", () => {
  assertEquals(enabledModules({ jira: [{ issue_key: "TNT-1" }] }), { jira: true, storefront: false });
  assertEquals(enabledModules({ jira: [] }), { jira: false, storefront: false });
  assertEquals(enabledModules(null), { jira: false, storefront: false });
  assertEquals(enabledModules(undefined), { jira: false, storefront: false });
});

Deno.test("toAskViewModel keeps found answers and https sources only", () => {
  const vm = toAskViewModel({
    found: true,
    answer: "  Bật Auto Currency trong Settings. ",
    sources: [
      { title: "Currency", url: "https://help.transcy.io/en/article/currency" },
      { title: "Evil", url: "javascript:alert(1)" },
      { title: "Thiếu url" },
    ],
  });
  assertEquals(vm, {
    found: true,
    answer: "Bật Auto Currency trong Settings.",
    sources: [{ title: "Currency", url: "https://help.transcy.io/en/article/currency" }],
  });
});

Deno.test("toAskViewModel treats found without a real answer as not found", () => {
  assertEquals(toAskViewModel({ found: false, answer: null, sources: [] }), { found: false, answer: "", sources: [] });
  assertEquals(toAskViewModel({ found: true, answer: "  ", sources: [] }).found, false);
  assertEquals(toAskViewModel(null), { found: false, answer: "", sources: [] });
});

Deno.test("askAnswerToHint trims and caps at the server hint limit (500)", () => {
  assertEquals(askAnswerToHint("  đáp án ngắn  "), "đáp án ngắn");
  assertEquals(askAnswerToHint("x".repeat(600)).length, 500);
  assertEquals(askAnswerToHint(null), "");
});

Deno.test("previewNeedsToggle: tin ngắn một dòng thì không cần nút xem thêm", () => {
  assertEquals(previewNeedsToggle("Khách hỏi về đơn hàng ạ"), false);
  assertEquals(previewNeedsToggle(""), false);
  assertEquals(previewNeedsToggle(null), false);
});

Deno.test("previewNeedsToggle: tin dài hoặc nhiều dòng thì thu gọn", () => {
  assertEquals(previewNeedsToggle("x".repeat(161)), true);
  assertEquals(previewNeedsToggle("a\nb\nc\nd"), true);
});

Deno.test("toStorefrontViewModel: need-shop/unconfigured tách riêng; error mang message khi server có nói", () => {
  assertEquals(toStorefrontViewModel({ status: "need-shop" }, NOW), { kind: "need-shop" });
  assertEquals(toStorefrontViewModel({ status: "unconfigured", error: "thiếu env" }, NOW), { kind: "unconfigured", message: "thiếu env" });
  assertEquals(toStorefrontViewModel({ status: "error", error: "HTTP 503" }, NOW), { kind: "error", message: "HTTP 503" });
  assertEquals(toStorefrontViewModel({ status: "error" }, NOW), { kind: "error" });
});

Deno.test("toStorefrontViewModel: results giữ fingerprint từng item để bấm mở chi tiết; notWatched lộ rõ", () => {
  const fp = "a".repeat(40);
  const vm = toStorefrontViewModel({
    status: "ok",
    store: "shop-x.myshopify.com",
    scannedAt: null,
    notWatched: true,
    new: [{ title: "Lỗi 1", meta: "high · de", fingerprint: fp }],
    acknowledged: [],
    inProgress: [],
  }, NOW);
  assertEquals(vm.kind, "results");
  assertEquals(vm.notWatched, true);
  // Item kiểu cũ (chỉ title/meta/fingerprint, không kind/page) không bị gom;
  // fingerprint của finding nằm ở entries[0] để panels bấm mở chi tiết.
  assertEquals(vm.groups[0].items[0], {
    title: "Lỗi 1", meta: "high · de", kind: null, page: null, locales: [], count: 1,
    entries: [{ fingerprint: fp, locale: null, meta: "high · de", severity: null, text: null, consoleLink: null, pageLink: null, issuePageLink: null, title: "Lỗi 1" }],
  });
});

Deno.test("toStorefrontViewModel: gom finding trùng căn nguyên (fixture 9 finding) — 3 Region missing ở / gom 1 mục, tổng vẫn 9", () => {
  const F = (fp, kind, locale, page) => ({
    title: kind, meta: "", fingerprint: fp, kind, locale, page,
    severity: "critical", text: null, consoleLink: `https://sw.transcy.io/#/f/${fp}`,
  });
  const vm = toStorefrontViewModel({
    status: "ok", store: "demo-store.com", scannedAt: null,
    new: [
      F("1111111111111111111111111111111111111111", "Region missing", "ja", "/"),
      F("2222222222222222222222222222222222222222", "Region missing", "zh", "/"),
      F("3333333333333333333333333333333333333333", "Region missing", "es", "/"),
      F("4444444444444444444444444444444444444444", "Option unidentifiable", "zh", "/products/product-a"),
      F("5555555555555555555555555555555555555555", "Graphic lost", "es", "/products/product-b"),
      F("6666666666666666666666666666666666666666", "Graphic lost", "zh", "/products/product-c"),
      F("7777777777777777777777777777777777777777", "Layout degraded", "es", "/products/product-d"),
      F("8888888888888888888888888888888888888888", "Option unidentifiable", "zh", "/products/product-b"),
      F("9999999999999999999999999999999999999999", "Block collapsed", "zh", "/products/product-b"),
    ],
    acknowledged: [], inProgress: [],
  }, NOW);
  assertEquals(vm.kind, "results");
  // Tổng đếm theo finding THẬT trước gom — gom không được làm lệch số.
  assertEquals(vm.totalCount, 9);
  const gNew = vm.groups[0];
  assertEquals(gNew.count, 9);
  // 9 finding → 7 mục: bộ ba Region missing gom 1; các kind+page còn lại đều khác nhau.
  assertEquals(gNew.items.length, 7);
  const region = gNew.items[0];
  assertEquals(region.kind, "Region missing");
  assertEquals(region.count, 3);
  assertEquals(region.locales, ["ja", "zh", "es"]);
  // Mọi fingerprint + console link vẫn riêng từng entry để mở chi tiết/deep-link đúng bug.
  assertEquals(region.entries.map((e) => e.fingerprint), [
    "1111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222",
    "3333333333333333333333333333333333333333",
  ]);
  assertEquals(region.entries[1].consoleLink, "https://sw.transcy.io/#/f/2222222222222222222222222222222222222222");
  // Hai finding cùng kind nhưng KHÁC page không bị gom lẫn.
  assertEquals(gNew.items.filter((i) => i.kind === "Graphic lost").length, 2);
});

Deno.test("toStorefrontViewModel: không gom XUYÊN nhóm trạng thái — cùng kind+page ở Mới và Đã xác nhận vẫn là 2 mục riêng", () => {
  const F = (fp) => ({ title: "Region missing", meta: "", fingerprint: fp, kind: "Region missing", locale: "ja", page: "/", severity: "critical", text: null, consoleLink: null });
  const vm = toStorefrontViewModel({
    status: "ok", store: "s.myshopify.com", scannedAt: null,
    new: [F("a".repeat(40))], acknowledged: [F("b".repeat(40))], inProgress: [],
  }, NOW);
  assertEquals(vm.totalCount, 2);
  assertEquals(vm.groups[0].items.length, 1);
  assertEquals(vm.groups[1].items.length, 1);
});

Deno.test("explanationTemplate: kind có mẫu → đoạn riêng theo kind, chèn sẵn page/locale/text của finding", () => {
  const t = explanationTemplate({ kind: "Region missing", locale: "ja", page: "/", text: null });
  assertEquals(t.includes("a section of content is missing on / in the ja version of the store"), true);
  assertEquals(t.includes("Our technical team is already aware"), true);
  const t2 = explanationTemplate({ kind: "Graphic lost", locale: "es", page: "/products/x", text: "Rosa" });
  assertEquals(t2.includes('an image is not loading on /products/x in the es version of the store (around the part showing "Rosa")'), true);
});

Deno.test("explanationTemplate: kind lạ / thiếu dữ kiện → mẫu chung, vẫn là tiếng Anh hoàn chỉnh, không nhắc tên công cụ nội bộ", () => {
  const t = explanationTemplate({ kind: "Lỗi chưa từng thấy", locale: null, page: null, text: null });
  assertEquals(t.includes("there is a display issue on your store"), true);
  assertEquals(t.includes("Storefront"), false);
  assertEquals(t.includes("fingerprint"), false);
  const empty = explanationTemplate({});
  assertEquals(empty.includes("there is a display issue on your store"), true);
  assertEquals(empty.length > 80, true);
});

// ---------- bổ sung rà soát trục 3: progress + view-model các trạng thái còn thiếu ----------

Deno.test("progressStepIndex: generate đi đủ 4 bước theo mốc 0/900/2200/4200ms và giữ ở bước cuối", () => {
  assertEquals(progressStepIndex("generate", 0), 0);
  assertEquals(progressStepIndex("generate", 899), 0);
  assertEquals(progressStepIndex("generate", 900), 1);
  assertEquals(progressStepIndex("generate", 2199), 1);
  assertEquals(progressStepIndex("generate", 2200), 2);
  assertEquals(progressStepIndex("generate", 4200), 3);
  // Chờ lâu đến mấy cũng không tự nhảy qua bước cuối — không báo hoàn thành giả.
  assertEquals(progressStepIndex("generate", 999999), 3);
});

Deno.test("progressStepIndex: analyze 2 bước, ask/handoff theo đúng số bước của chúng; action không có thẻ tiến trình → 0", () => {
  assertEquals(progressStepIndex("analyze", 0), 0);
  assertEquals(progressStepIndex("analyze", 900), 1);
  assertEquals(progressStepIndex("analyze", 999999), 1);
  assertEquals(progressStepIndex("ask", 2200), 2);
  assertEquals(progressStepIndex("ask", 999999), 2);
  assertEquals(progressStepIndex("handoff", 900), 1);
  assertEquals(progressStepIndex("survey", 5000), 0);
  assertEquals(progressStepIndex("storefront", 5000), 0);
  assertEquals(progressStepIndex("", 5000), 0);
});

Deno.test("PROGRESS_STEPS: chỉ 4 action AI có thẻ tiến trình (survey/jira/storefront dùng nhãn bận riêng)", () => {
  assertEquals(Object.keys(PROGRESS_STEPS).sort(), ["analyze", "ask", "generate", "handoff"]);
});

Deno.test("actionButtonState: ma trận loại trừ lẫn nhau cho MỌI action đang chạy (kể cả storefront/jira)", () => {
  const actions = ["generate", "analyze", "ask", "handoff", "survey", "jira_sync", "jira_unlink", "storefront"];
  for (const running of actions) {
    for (const a of actions) {
      assertEquals(actionButtonState(running, a), { running: running === a, disabled: true }, `${running} vs ${a}`);
    }
  }
  for (const a of actions) assertEquals(actionButtonState("", a), { running: false, disabled: false }, a);
});

Deno.test("toViewModel: đúng 1 tin chờ và 0 tin chờ — header/hiddenPendingCount/botRepliedCount", () => {
  const one = toViewModel({ ...CHECK, unanswered: ["chỉ một tin"] }, NOW);
  assertEquals(one.header, "1 tin khách đang chờ");
  assertEquals(one.pendingCount, 1);
  assertEquals(one.hiddenPendingCount, 0);
  assertEquals(one.unanswered, ["chỉ một tin"]);
  const zero = toViewModel({ ...CHECK, needs_reply: false, unanswered: [] }, NOW);
  assertEquals(zero.pendingCount, 0);
  assertEquals(zero.pendingMessages, []);
  assertEquals(zero.botRepliedCount, 0);
});

Deno.test("toViewModel: pending_messages có sẵn thắng unanswered thô và giữ cờ bot_replied", () => {
  const vm = toViewModel({
    ...CHECK,
    unanswered: ["bản thô bị bỏ qua"],
    pending_messages: [{ text: "tin 1", bot_replied: true }, { text: "tin 2", bot_replied: false }],
  }, NOW);
  assertEquals(vm.unanswered, ["tin 1", "tin 2"]);
  assertEquals(vm.pendingMessages.map((m) => m.botReplied), [true, false]);
  assertEquals(vm.botRepliedCount, 1);
});

Deno.test("toIssuesViewModel: đúng 1 issue → đúng 1 thẻ; sentiment không có issues → rỗng", () => {
  assertEquals(toIssuesViewModel(CHECK, { issues: [{ summary: "Khách mất hoá đơn", evidence: "" }] }).issues, [{ title: "Khách mất hoá đơn", detail: null }]);
  assertEquals(toIssuesViewModel(CHECK, { issues: [] }).issues, []);
  assertEquals(toIssuesViewModel(CHECK, {}).issues, []);
});

Deno.test("toJiraViewModel: rỗng/null → []; nhiều ticket giữ nguyên thứ tự; Done đã báo khách vẫn được liệt kê khi server còn gửi (việc ẩn là phía server)", () => {
  assertEquals(toJiraViewModel([], NOW), []);
  assertEquals(toJiraViewModel(null, NOW), []);
  assertEquals(toJiraViewModel(undefined, NOW), []);
  const mk = (key, over = {}) => ({
    issue_key: key, url: `https://firegroup.atlassian.net/browse/${key}`, summary: null, status: "Done",
    has_update: false, status_changed: false, prev_status: null, awaiting_report: false, new_comments: [], ...over,
  });
  const vm = toJiraViewModel([mk("TNT-9"), mk("TNT-10"), mk("TNT-11")], NOW);
  assertEquals(vm.map((j) => j.key), ["TNT-9", "TNT-10", "TNT-11"]);
  // Done + đã báo (awaiting_report=false, has_update=false): widget KHÔNG tự lọc —
  // server không trả ticket dạng này nữa thì panel mới ẩn; còn trả thì còn hiện, không badge.
  assertEquals(vm[0].awaitingReport, false);
  assertEquals(vm[0].hasUpdate, false);
  assertEquals(vm[0].statusLine, null);
  assertEquals(vm[0].latestTech, null);
});

Deno.test("toJiraViewModel: server thiếu new_comments (bản ghi cũ) không được làm sập render panel", () => {
  const vm = toJiraViewModel([{
    issue_key: "TNT-7", url: "https://firegroup.atlassian.net/browse/TNT-7", summary: "Legacy", status: "Open",
    has_update: false, status_changed: false, prev_status: null, awaiting_report: false,
  }], NOW);
  assertEquals(vm[0].latestTech, null);
  assertEquals(vm[0].name, "Legacy");
});

Deno.test("toStorefrontViewModel: results 0 findings → totalCount 0 và 3 nhóm đều rỗng (panel hiện 'Không phát hiện lỗi')", () => {
  const vm = toStorefrontViewModel({ status: "ok", store: "shop.myshopify.com", scannedAt: "2026-10-16T09:59:00Z", new: [], acknowledged: [], inProgress: [] }, NOW);
  assertEquals(vm.kind, "results");
  assertEquals(vm.totalCount, 0);
  assertEquals(vm.groups.map((g) => g.items.length), [0, 0, 0]);
  assertEquals(vm.scannedLabel, "1 phút trước");
});

Deno.test("toStorefrontViewModel: nhận cả key in_progress (snake_case) như inProgress; scannedAt null → scannedLabel null", () => {
  const vm = toStorefrontViewModel({
    status: "ok", store: "shop.myshopify.com", scannedAt: null,
    in_progress: [{ title: "Đang xử lý 1", meta: "CS đã liên hệ" }],
  }, NOW);
  assertEquals(vm.groups[2].items.map((i) => i.title), ["Đang xử lý 1"]);
  assertEquals(vm.scannedLabel, null);
  assertEquals(vm.totalCount, 1);
});
