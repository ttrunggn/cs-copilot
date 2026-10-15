import { assertEquals } from "jsr:@std/assert@1";
import { humanTranscript, unansweredCustomerMessages } from "../_shared/context.ts";
import type { MessageRow } from "../_shared/types.ts";

const m = (from: "user" | "operator", content: string, minute: number, extra: Partial<MessageRow> = {}): MessageRow => ({
  from,
  type: "text",
  is_bot: false,
  content,
  created_at: `2026-10-15T03:${String(minute).padStart(2, "0")}:00+00:00`,
  operator_name: from === "operator" ? "Lan" : null,
  ...extra,
});

Deno.test("humanTranscript drops bot messages and events, labels notes", () => {
  const out = humanTranscript([
    m("user", "Hi", 1),
    m("operator", "I am Mary", 2, { is_bot: true, operator_name: "Mary" }),
    m("operator", "check log", 3, { type: "note" }),
    m("operator", "", 4, { type: "event" }),
    m("operator", "Chào bạn", 5),
  ]);
  assertEquals(out, "Khách: Hi\nCS (Lan): [Ghi chú nội bộ] check log\nCS (Lan): Chào bạn");
});

Deno.test("humanTranscript sorts by time and keeps the last N lines", () => {
  const out = humanTranscript([m("user", "c", 3), m("user", "a", 1), m("user", "b", 2)], 2);
  assertEquals(out, "Khách: b\nKhách: c");
});

Deno.test("unanswered: trailing customer messages after last human reply", () => {
  assertEquals(
    unansweredCustomerMessages([m("user", "a", 1), m("operator", "b", 2), m("user", "c", 3), m("user", "d", 4)]),
    ["c", "d"],
  );
});

Deno.test("unanswered: bot replies do not count as answered", () => {
  assertEquals(
    unansweredCustomerMessages([m("user", "a", 1), m("operator", "bot", 2, { is_bot: true }), m("user", "c", 3)]),
    ["a", "c"],
  );
});

Deno.test("unanswered: internal notes do not count as a reply", () => {
  assertEquals(unansweredCustomerMessages([m("user", "a", 1), m("operator", "note", 2, { type: "note" })]), ["a"]);
});

Deno.test("unanswered: empty when a human CS replied last", () => {
  assertEquals(unansweredCustomerMessages([m("user", "a", 1), m("operator", "ok", 2)]), []);
});
