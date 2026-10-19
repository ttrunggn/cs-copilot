import { assertEquals } from "jsr:@std/assert@1";
import { humanTranscript, inputFingerprint, latestCustomerQuery, unansweredCustomerMessages } from "../_shared/context.ts";
import type { MessageRow } from "../_shared/types.ts";

let nextId = 1;
const m = (from: "user" | "operator", content: string, minute: number, extra: Partial<MessageRow> = {}): MessageRow => ({
  id: nextId++,
  content_en: null,
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
  assertEquals(out, "Customer: Hi\nAgent (Lan): [Internal note] check log\nAgent (Lan): Chào bạn");
});

Deno.test("humanTranscript sorts by time and keeps the last N lines", () => {
  const out = humanTranscript([m("user", "c", 3), m("user", "a", 1), m("user", "b", 2)], 2);
  assertEquals(out, "Customer: b\nCustomer: c");
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

Deno.test("humanTranscript uses content_en and English labels", () => {
  const out = humanTranscript([m("user", "Je veux un remboursement", 1, { content_en: "I want a refund" }), m("operator", "Sure", 2)]);
  assertEquals(out, "Customer: I want a refund\nAgent (Lan): Sure");
});

Deno.test("latestCustomerQuery prefers unanswered English text", () => {
  const q = latestCustomerQuery([
    m("user", "old", 1),
    m("operator", "ok", 2),
    m("user", "Bonjour", 3, { content_en: "Hello" }),
    m("user", "switcher cassé", 4, { content_en: "switcher broken" }),
  ]);
  assertEquals(q, "Hello\nswitcher broken");
});

Deno.test("latestCustomerQuery falls back to the last customer message", () => {
  assertEquals(latestCustomerQuery([m("user", "a", 1), m("user", "b", 2), m("operator", "done", 3)]), "b");
});

Deno.test("inputFingerprint changes when a message is added", async () => {
  const base = [m("user", "a", 1)];
  const a = await inputFingerprint("draft", "op", base);
  assertEquals(a, await inputFingerprint("draft", "op", base));
  assertEquals(a === (await inputFingerprint("draft", "op", [...base, m("operator", "b", 2)])), false);
  assertEquals(a === (await inputFingerprint("handoff", "op", base)), false);
});

Deno.test("humanTranscript keeps a long multi-issue customer message whole", () => {
  const long = "Issue one. ".repeat(400) + "LAST ISSUE: refund please"; // ~4400 ký tự
  assertEquals(humanTranscript([m("user", long, 1)]).endsWith("LAST ISSUE: refund please"), true);
});

Deno.test("humanTranscript drops the oldest lines beyond the total budget, never the newest", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => m("user", `${i}:` + "x".repeat(5000), i + 1));
  const out = humanTranscript(msgs);
  assertEquals(out.length <= 24000, true, `length ${out.length}`);
  assertEquals(out.includes("Customer: 9:"), true);
  assertEquals(out.includes("Customer: 0:"), false);
});
