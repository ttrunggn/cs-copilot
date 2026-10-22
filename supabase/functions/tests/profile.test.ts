import { assertEquals } from "jsr:@std/assert@1";
import { BUILTIN_PROFILE, resolveNoteFormat, resolveProfile } from "../_shared/profile.ts";
import type { NoteFormat, ProfileRow } from "../_shared/types.ts";

const row = (topic: string, extra: Partial<ProfileRow> = {}): ProfileRow => ({
  crisp_user_id: "op-lan",
  website_id: "ws1",
  topic,
  conversations_used: 10,
  learned_at: "2026-10-14T00:00:00Z",
  manual_override: null,
  ...extra,
});

Deno.test("no rows -> workspace default over builtin", () => {
  const r = resolveProfile([], "billing", { pronoun_customer: "anh/chị" });
  assertEquals(r.source, "default");
  assertEquals(r.profile, { ...BUILTIN_PROFILE, pronoun_customer: "anh/chị" });
});

Deno.test("topic row wins", () => {
  const r = resolveProfile([row("_all", { tone: "chung" }), row("billing", { tone: "chi tiết" })], "billing", {});
  assertEquals(r.source, "topic");
  assertEquals(r.profile.tone, "chi tiết");
});

Deno.test("missing topic row falls back to _all", () => {
  const r = resolveProfile([row("_all", { tone: "chung" })], "refund", {});
  assertEquals(r.source, "all");
  assertEquals(r.profile.tone, "chung");
});

Deno.test("null topic uses _all", () => {
  const r = resolveProfile([row("_all", { tone: "chung" }), row("billing", { tone: "x" })], null, {});
  assertEquals(r.source, "all");
});

Deno.test("manual_override beats learned values", () => {
  const r = resolveProfile([row("billing", { tone: "learned", manual_override: { tone: "lead set" } })], "billing", {});
  assertEquals(r.profile.tone, "lead set");
});

Deno.test("_all override applies to topic profiles, topic override wins over it", () => {
  const rows = [
    row("_all", { manual_override: { signature: "— Lan", use_emoji: false } }),
    row("billing", { use_emoji: true, manual_override: { use_emoji: true } }),
  ];
  const r = resolveProfile(rows, "billing", {});
  assertEquals(r.profile.signature, "— Lan");
  assertEquals(r.profile.use_emoji, true);
});

Deno.test("null learned fields do not erase defaults", () => {
  const r = resolveProfile([row("_all", { tone: undefined, pronoun_self: null as unknown as string })], null, { tone: "ws tone" });
  assertEquals(r.profile.tone, "ws tone");
  assertEquals(r.profile.pronoun_self, BUILTIN_PROFILE.pronoun_self);
});

Deno.test("built-in profile writes in English", () => {
  assertEquals([BUILTIN_PROFILE.pronoun_self, BUILTIN_PROFILE.pronoun_customer, BUILTIN_PROFILE.tone], ["I", "you", "friendly, polite, concise"]);
});

const NOTE_FMT: NoteFormat = {
  language: "vi",
  header: "Bàn giao — {name}",
  sections: [{ field: "issues", label: "Vấn đề:" }],
  line_style: "bullets",
  state_style: "text",
  sign_off: null,
  notes_used: 6,
};

Deno.test("resolveNoteFormat reads the format from the _all row only", () => {
  assertEquals(resolveNoteFormat([]), null);
  assertEquals(resolveNoteFormat([row("billing", { note_format: NOTE_FMT })]), null);
  assertEquals(resolveNoteFormat([row("_all", { note_format: NOTE_FMT })]), NOTE_FMT);
  assertEquals(resolveNoteFormat([row("_all")]), null);
});

Deno.test("resolveNoteFormat rejects a format learned from too few notes", () => {
  assertEquals(resolveNoteFormat([row("_all", { note_format: { ...NOTE_FMT, notes_used: 2 } })]), null);
});

Deno.test("resolveNoteFormat: manual_override note_format beats the learned one", () => {
  const manual = { ...NOTE_FMT, language: "en" as const, header: "Handoff — {name}" };
  const rows = [row("_all", {
    note_format: NOTE_FMT,
    manual_override: { note_format: manual } as unknown as ProfileRow["manual_override"],
  })];
  assertEquals(resolveNoteFormat(rows), manual);
});
