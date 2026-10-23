import { assertEquals } from "jsr:@std/assert@1";
import { BUILTIN_PROFILE, pickBestNoteFormat, pickBestProfileRow, rebindIdentity, resolveNoteFormat, resolveProfile } from "../_shared/profile.ts";
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

Deno.test("pickBestProfileRow picks the _all row with most conversations, floor applied", () => {
  const rows = [
    row("_all", { crisp_user_id: "op-a", conversations_used: 40, tone: "a" }),
    row("_all", { crisp_user_id: "op-b", conversations_used: 120, tone: "b" }),
    row("_all", { crisp_user_id: "op-c", conversations_used: 3, tone: "c" }),
    row("billing", { crisp_user_id: "op-d", conversations_used: 999, tone: "d" }),
  ];
  assertEquals(pickBestProfileRow(rows)?.crisp_user_id, "op-b");
  assertEquals(pickBestProfileRow([row("_all", { conversations_used: 4 })]), null);
  assertEquals(pickBestProfileRow([]), null);
});

Deno.test("pickBestProfileRow tie-breaks by latest learned_at", () => {
  const rows = [
    row("_all", { crisp_user_id: "op-old", conversations_used: 50, learned_at: "2026-09-01T00:00:00Z" }),
    row("_all", { crisp_user_id: "op-new", conversations_used: 50, learned_at: "2026-10-01T00:00:00Z" }),
  ];
  assertEquals(pickBestProfileRow(rows)?.crisp_user_id, "op-new");
});

Deno.test("resolveProfile: no own rows -> best team profile under workspace default", () => {
  const best = row("_all", { crisp_user_id: "op-b", tone: "giọng tốt nhất", pronoun_self: "mình" });
  const r = resolveProfile([], "billing", {}, best);
  assertEquals(r.source, "best");
  assertEquals(r.profile.tone, "giọng tốt nhất");
  const r2 = resolveProfile([], "billing", { tone: "ws tone" }, best);
  assertEquals(r2.profile.tone, "ws tone");
  assertEquals(r2.profile.pronoun_self, "mình");
});

Deno.test("resolveProfile: own rows and own manual override beat the best row", () => {
  const best = row("_all", { crisp_user_id: "op-b", tone: "best", signature: "— Best" });
  const own = [row("_all", { tone: "của mình", manual_override: { signature: "— Tôi" } })];
  const r = resolveProfile(own, null, {}, best);
  assertEquals(r.source, "all");
  assertEquals(r.profile.tone, "của mình");
  assertEquals(r.profile.signature, "— Tôi");
});

Deno.test("resolveProfile: best row contributes style but never its signature", () => {
  const best = row("_all", { crisp_user_id: "op-b", tone: "best", signature: "This is Raymond from Transcy" });
  const r = resolveProfile([], null, {}, best);
  assertEquals(r.source, "best");
  assertEquals(r.profile.tone, "best");
  assertEquals(r.profile.signature, null);
  // Workspace default signature (mức team) vẫn được dùng khi lớp best bị khử chữ ký.
  const r2 = resolveProfile([], null, { signature: "Transcy Support Team" }, best);
  assertEquals(r2.profile.signature, "Transcy Support Team");
});

Deno.test("rebindIdentity swaps the donor name for the borrower's in samples and signature", () => {
  const p = {
    ...BUILTIN_PROFILE,
    signature: "Regards, Raymond",
    sample_messages: [
      "Hi there, This is Raymond from the Customer Success Team at Transcy.",
      "Raymond here — checking your store now.",
      "Your Raymond-style discount code is safe with me.",
    ],
  };
  const out = rebindIdentity(p, "Raymond Tran", "Ethan Nguyen");
  // Tên đầy đủ và tên gọi đều đổi; từ ghép chứa tên (Raymond-style) không bị đụng.
  assertEquals(out.signature, "Regards, Ethan");
  assertEquals(out.sample_messages[0], "Hi there, This is Ethan from the Customer Success Team at Transcy.");
  assertEquals(out.sample_messages[1], "Ethan here — checking your store now.");
  assertEquals(out.sample_messages[2], "Your Raymond-style discount code is safe with me.");
  // Không đổi khi thiếu tên hoặc trùng tên.
  assertEquals(rebindIdentity(p, "", "Ethan Nguyen"), p);
  assertEquals(rebindIdentity(p, "Ethan Nguyen", "Ethan Nguyen"), p);
});

Deno.test("pickBestNoteFormat picks most notes_used, ignores manual-only formats", () => {
  const manualOnly = { ...NOTE_FMT, notes_used: 99, header: "Manual — {name}" };
  const rows = [
    row("_all", { crisp_user_id: "op-a", note_format: { ...NOTE_FMT, notes_used: 5 } }),
    row("_all", { crisp_user_id: "op-b", note_format: { ...NOTE_FMT, notes_used: 12, header: "B — {name}" } }),
    row("_all", { crisp_user_id: "op-c", note_format: null, manual_override: { note_format: manualOnly } as unknown as ProfileRow["manual_override"] }),
    row("_all", { crisp_user_id: "op-d", note_format: { ...NOTE_FMT, notes_used: 2 } }),
  ];
  const best = pickBestNoteFormat(rows);
  assertEquals(best?.header, "B — {name}");
  assertEquals(best?.notes_used, 12);
});

Deno.test("resolveNoteFormat falls back to the best team format, own format wins", () => {
  const best = { ...NOTE_FMT, header: "Team — {name}" };
  assertEquals(resolveNoteFormat([], best), best);
  assertEquals(resolveNoteFormat([row("_all", { note_format: NOTE_FMT })], best), NOTE_FMT);
  assertEquals(resolveNoteFormat([], null), null);
});
