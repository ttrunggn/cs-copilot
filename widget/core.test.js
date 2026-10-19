import { assertEquals } from "jsr:@std/assert@1";
import { mapError, readContext, timeAgo, toViewModel } from "./core.js";

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
  assertEquals(vm.header, "4 tin khách chưa trả lời");
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
  assertEquals(vm.header, "Không có tin chờ trả lời");
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
