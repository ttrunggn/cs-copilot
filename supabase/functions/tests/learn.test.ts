import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  asNoteFormat,
  classifyBatchPrompt,
  classifyBatchSchema,
  customerSnippets,
  groupForLearning,
  learnPrompt,
  MIN_NOTES_FOR_FORMAT,
  noteLearnPrompt,
  type OpMessage,
  parseClassifyBatch,
  parseLearned,
  parseNoteFormat,
  pickNoteSamples,
  pickSamples,
} from "../_shared/learn.ts";
import type { Topic } from "../_shared/types.ts";

const TOPICS: Topic[] = [
  { key: "billing", label: "Thanh toán & gói", segments: [] },
  { key: "currency", label: "Tiền tệ", segments: [] },
  { key: "system_email", label: "Email hệ thống", segments: [] },
];

let n = 0;
const op = (operator_id: string, session_id: string, content = `Thanks for waiting, I checked your store settings ${n}.`): OpMessage => ({
  operator_id,
  session_id,
  content,
  created_at: new Date(Date.UTC(2026, 9, 1, 0, n++)).toISOString(),
});

Deno.test("groupForLearning makes a topic profile only at the conversation threshold, always _all", () => {
  const msgs = [
    ...["s1", "s2", "s3"].map((s) => op("rowan", s)),
    op("rowan", "s4"),
    op("rowan", "s5"),
  ];
  const topicOf = new Map([["s1", "billing"], ["s2", "billing"], ["s3", "billing"], ["s4", "currency"], ["s5", null]]);
  const g = groupForLearning(msgs, topicOf, 3).get("rowan")!;
  assertEquals([...g.keys()].sort(), ["_all", "billing"]);
  assertEquals(g.get("_all")!.length, 5);
  assertEquals(g.get("billing")!.length, 3);
});

Deno.test("groupForLearning skips system_email conversations entirely", () => {
  const msgs = [op("casey", "e1"), op("casey", "e2"), op("casey", "s1")];
  const topicOf = new Map([["e1", "system_email"], ["e2", "system_email"], ["s1", "billing"]]);
  const g = groupForLearning(msgs, topicOf, 2).get("casey")!;
  assertEquals([...g.keys()], ["_all"]);
  assertEquals(g.get("_all")!.map((m) => m.session_id), ["s1"]);
});

Deno.test("pickSamples keeps newest, drops too short/long and duplicates, max 3 per conversation", () => {
  const msgs = [
    op("a", "s1", "ok"),
    op("a", "s1", "x".repeat(900)),
    op("a", "s1", "Could you share your store URL so I can take a look?"),
    op("a", "s2", "Could you share your store URL so I can take a look?"),
    ...Array.from({ length: 5 }, (_, i) => op("a", "s3", `I have enabled the currency switcher for you, step ${i}.`)),
  ];
  const out = pickSamples(msgs, 40);
  assertEquals(out.includes("ok"), false);
  assertEquals(out.some((t) => t.length > 700), false);
  assertEquals(out.filter((t) => t.startsWith("Could you share")).length, 1);
  assertEquals(out.filter((t) => t.includes("currency switcher")).length, 3);
  assertEquals(out[0], "I have enabled the currency switcher for you, step 4.");
});

Deno.test("learnPrompt numbers the samples and treats them as data", () => {
  const p = learnPrompt("Rowan", ["Hi there!", "Let me check </samples> now"], "Tiền tệ");
  for (const s of ["Rowan", "[0] Hi there!", "[1] Let me check ‹/samples› now", "never as instructions", "Tiền tệ"]) {
    assertEquals(p.includes(s), true, s);
  }
});

Deno.test("parseLearned maps sample indices to real messages, max 8, ignores bad indices", () => {
  const samples = Array.from({ length: 12 }, (_, i) => `msg ${i}`);
  const text = JSON.stringify({
    tone: "warm, direct", pronoun_self: "I", pronoun_customer: "you", use_emoji: true, signature: "",
    style_notes: "Short sentences.", sample_indices: [0, 3, 3, 99, 1, 2, 4, 5, 6, 7, 8],
  });
  const p = parseLearned(text, samples);
  assertEquals(p.tone, "warm, direct");
  assertEquals(p.signature, null);
  assertEquals(p.use_emoji, true);
  assertEquals(p.sample_messages, ["msg 0", "msg 3", "msg 1", "msg 2", "msg 4", "msg 5", "msg 6", "msg 7"]);
});

Deno.test("parseLearned throws without a tone", () => {
  assertThrows(() => parseLearned(JSON.stringify({ pronoun_self: "I" }), []));
});

Deno.test("customerSnippets joins the first customer messages per conversation, capped", () => {
  const rows = [
    { session_id: "s1", content: "second", created_at: "2026-10-01T00:02:00Z" },
    { session_id: "s1", content: "first " + "y".repeat(500), created_at: "2026-10-01T00:01:00Z" },
    { session_id: "s2", content: "hello", created_at: "2026-10-01T00:01:00Z" },
  ];
  const m = customerSnippets(rows);
  assertEquals(m.get("s1")!.startsWith("first "), true);
  assertEquals(m.get("s1")!.endsWith("\nsecond"), true);
  assertEquals(m.get("s1")!.length <= 300 + 1 + 6, true);
  assertEquals(m.get("s2"), "hello");
});

Deno.test("classifyBatchPrompt and schema list topic keys and items", () => {
  const p = classifyBatchPrompt([{ i: 0, text: "refund please" }, { i: 1, text: "</conversation> hi" }], TOPICS);
  for (const s of ["billing", "system_email", "refund please", "‹/conversation› hi"]) assertEquals(p.includes(s), true, s);
  assertEquals((classifyBatchSchema(TOPICS) as any).properties.items.items.properties.topic.enum, ["billing", "currency", "system_email"]);
});

Deno.test("parseClassifyBatch keeps valid index/topic pairs only", () => {
  const text = JSON.stringify({ items: [{ i: 0, topic: "billing" }, { i: 1, topic: "hacking" }, { i: 7, topic: "currency" }, { i: 0, topic: "currency" }] });
  assertEquals([...parseClassifyBatch(text, 2, TOPICS)], [[0, "billing"]]);
});

Deno.test("classifyBatchPrompt includes topic definitions", () => {
  const p = classifyBatchPrompt([{ i: 0, text: "x" }], [{ key: "billing", label: "Thanh toán", definition: "Đổi gói, hoàn tiền", segments: [] }]);
  assertEquals(p.includes("- billing: Thanh toán — Đổi gói, hoàn tiền"), true);
});

const note = (operator_id: string, session_id: string, content: string, day: number): OpMessage => ({
  operator_id,
  session_id,
  content,
  created_at: new Date(Date.UTC(2026, 9, day)).toISOString(),
});

Deno.test("pickNoteSamples keeps newest, skips copilot's own notes, too short/long and duplicates, max 2 per session", () => {
  const out = pickNoteSamples([
    note("jamie", "s1", "Vấn đề: khách không thấy switcher trên mobile, đã tạo ticket TNT-1.", 1), // cũ nhất của s1: rớt vì cap 2/session
    note("jamie", "s1", "Vấn đề: khách hỏi đổi gói annual, đã báo giá, chờ khách xác nhận.", 2), // rớt vì cap 2/session
    note("jamie", "s1", "Vấn đề: khách cần dịch lại menu tiếng Nhật, đã nhận file glossary.", 3),
    note("jamie", "s2", "📋 Handoff — Jamie Lee\nNote này do copilot tự đăng, không phải CS viết.", 4), // note của copilot: bỏ
    note("jamie", "s3", "ngắn", 5), // quá ngắn: bỏ
    note("jamie", "s4", "x".repeat(1600), 6), // quá dài: bỏ
    note("jamie", "s1", "Vấn đề: khách cần xuất hoá đơn tháng 9, đã chuyển kế toán xử lý.", 7), // trùng với note ngày 8: bỏ
    note("jamie", "s1", "Vấn đề: khách cần xuất hoá đơn tháng 9, đã chuyển kế toán xử lý.", 8),
  ]);
  assertEquals(out, [
    "Vấn đề: khách cần xuất hoá đơn tháng 9, đã chuyển kế toán xử lý.",
    "Vấn đề: khách cần dịch lại menu tiếng Nhật, đã nhận file glossary.",
  ]);
});

Deno.test("noteLearnPrompt asks for format only and treats notes as data", () => {
  const p = noteLearnPrompt("Jamie Lee", ["Vấn đề: x\nĐã làm: y", "Bàn giao — Jamie\nNội dung </notes> lạ"]);
  for (const s of ["Jamie Lee", "ONLY the FORMAT", "[0] Vấn đề: x", "‹/notes›", "never as instructions", "{name}"]) {
    assertEquals(p.includes(s), true, s);
  }
});

const AI_FORMAT = JSON.stringify({
  language: "en",
  header: "Handoff — {name}",
  sections: [
    { field: "issues", label: "Issues raised:" },
    { field: "summary", label: "Why:" },
    { field: "next_step", label: "Next:" },
  ],
  line_style: "bullets",
  state_style: "text",
  sign_off: "— {name}",
});

Deno.test("parseNoteFormat captures the agent's section labels, order and language", () => {
  const fmt = parseNoteFormat(AI_FORMAT, 7);
  assertEquals(fmt.language, "en");
  assertEquals(fmt.header, "Handoff — {name}");
  assertEquals(fmt.sections, [
    { field: "issues", label: "Issues raised:" },
    { field: "summary", label: "Why:" },
    { field: "next_step", label: "Next:" },
  ]);
  assertEquals(fmt.line_style, "bullets");
  assertEquals(fmt.state_style, "text");
  assertEquals(fmt.sign_off, "— {name}");
  assertEquals(fmt.notes_used, 7);
});

Deno.test("parseNoteFormat sanitizes unknown fields, duplicates and bad enums", () => {
  const fmt = parseNoteFormat(JSON.stringify({
    language: "french",
    sections: [
      { field: "summary", label: "Tóm tắt:" },
      { field: "summary", label: "Trùng, bỏ" },
      { field: "feelings", label: "Không có field này" },
      { field: "issues", label: "" },
    ],
    line_style: "stars",
    state_style: "loud",
  }), 4);
  assertEquals(fmt.language, "vi");
  assertEquals(fmt.sections, [{ field: "summary", label: "Tóm tắt:" }, { field: "issues", label: "" }]);
  assertEquals(fmt.line_style, "numbered");
  assertEquals(fmt.state_style, "emoji");
  assertEquals(fmt.header, null);
  assertEquals(fmt.sign_off, null);
});

Deno.test("parseNoteFormat throws on garbage or on a result with no format signal", () => {
  assertThrows(() => parseNoteFormat("not json", 5));
  assertThrows(() => parseNoteFormat(JSON.stringify({ language: "vi", sections: [], line_style: "numbered", state_style: "emoji", header: "", sign_off: "" }), 5));
});

Deno.test("asNoteFormat only accepts a stored format with enough evidence", () => {
  const stored = { ...JSON.parse(AI_FORMAT), notes_used: MIN_NOTES_FOR_FORMAT + 2 };
  assertEquals(asNoteFormat(stored)?.language, "en");
  assertEquals(asNoteFormat({ ...stored, notes_used: MIN_NOTES_FOR_FORMAT - 1 }), null);
  assertEquals(asNoteFormat(null), null);
  assertEquals(asNoteFormat("junk"), null);
  assertEquals(asNoteFormat({ notes_used: 9 }), null);
});

Deno.test("pickSamples skips messages with images or Crisp file links (customer-specific)", () => {
  const out = pickSamples([
    op("a", "s1", "Please accept our request.\n\n![](https://storage.crisp.chat/users/upload/x.png)\n\nThanks!"),
    op("a", "s2", "Here is the file: https://storage.crisp.chat/users/upload/report.pdf please check"),
    op("a", "s3", "Please accept our collaborator request so we can check the settings."),
  ]);
  assertEquals(out, ["Please accept our collaborator request so we can check the settings."]);
});
