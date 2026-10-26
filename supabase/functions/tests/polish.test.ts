import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { draftPrompt, parsePolish, stripEmDashes } from "../_shared/prompts.ts";
import type { Profile } from "../_shared/types.ts";

Deno.test("stripEmDashes: gọt mọi dạng dấu gạch ngang dài thành dấu phẩy", () => {
  assertEquals(stripEmDashes("Thanks for waiting — I checked your store."), "Thanks for waiting, I checked your store.");
  assertEquals(stripEmDashes("Hi — you're speaking with a human."), "Hi, you're speaking with a human.");
  assertEquals(stripEmDashes("Không có dấu nào."), "Không có dấu nào.");
});

Deno.test("parsePolish: needs_polish=false → null", () => {
  assertEquals(parsePolish(JSON.stringify({ needs_polish: false, reason: "", improved: "" }), "draft gốc"), null);
});

Deno.test("parsePolish: bản gợi ý hợp lệ → trả reason + text, đã gọt dấu gạch ngang dài", () => {
  const out = parsePolish(JSON.stringify({
    needs_polish: true,
    reason: "Người bản xứ sẽ khựng ở \"is being showed\" (sai ngữ pháp).",
    improved: "Thanks for waiting — the translation is now showing.",
  }), "Thanks for waiting, the translation is being showed.");
  assertEquals(out?.reason, "Người bản xứ sẽ khựng ở \"is being showed\" (sai ngữ pháp).");
  assertEquals(out?.text, "Thanks for waiting, the translation is now showing.");
});

Deno.test("parsePolish: gợi ý trùng bản gốc hoặc JSON hỏng → null", () => {
  assertEquals(parsePolish(JSON.stringify({ needs_polish: true, reason: "x", improved: "giống hệt" }), "giống hệt"), null);
  assertEquals(parsePolish("không phải json", "draft"), null);
});

Deno.test("draftPrompt: chứa luật cứng không dùng dấu gạch ngang dài", () => {
  const profile = {
    tone: "friendly", pronoun_self: "I", pronoun_customer: "you",
    use_emoji: false, signature: null, style_notes: null, sample_messages: [],
  } as unknown as Profile;
  const p = draftPrompt({ profile, topicLabel: null, transcript: "Customer: hi", helpdesk: [], cases: [], variantNotes: null });
  assertStringIncludes(p, "Never use the em dash character (—)");
});

Deno.test("parsePolish: cụm bị nêu trong lý do vẫn còn nguyên trong bản gợi ý → bỏ thẻ (ca live 2026-10-26)", () => {
  const original = "Hi there,\n\nThis is Ethan from the Transcy Customer Support team.\n\nI am here now to help you directly.\n\nThank you for your patience!";
  const r = parsePolish(JSON.stringify({
    needs_polish: true,
    reason: "Người bản xứ sẽ khựng ở 'am here now to help you directly' vì nghe hơi gượng gạo",
    improved: "Hi there,\n\nThis is Ethan from the Transcy Customer Support team.\n\nI am here now to help you directly.\n\nThank you for your patience!",
  }), original);
  assertEquals(r, null);
});

Deno.test("parsePolish: cụm bị nêu đã được sửa trong bản gợi ý → giữ thẻ", () => {
  const original = "Hi there,\n\nI am here now to help you directly.\n\nThank you for your patience!";
  const r = parsePolish(JSON.stringify({
    needs_polish: true,
    reason: "Người bản xứ sẽ khựng ở 'am here now to help you directly' vì nghe hơi gượng gạo",
    improved: "Hi there,\n\nI'm here to help you directly.\n\nThank you for your patience!",
  }), original);
  assertEquals(r?.text.includes("I'm here to help you directly."), true);
});
