import { assertEquals } from "jsr:@std/assert@1";
import { ensureEnglish, looksEnglish } from "../_shared/translate.ts";
import { type Ai, AiUnavailable } from "../_shared/gemini.ts";
import type { MessageRow } from "../_shared/types.ts";

const msg = (id: number, content: string, extra: Partial<MessageRow> = {}): MessageRow => ({
  id, content, content_en: null, from: "user", type: "text", is_bot: false,
  created_at: `2026-10-15T03:${String(id).padStart(2, "0")}:00+00:00`, operator_name: null, ...extra,
});

function fakeAi(reply: (prompt: string) => string | Error) {
  const prompts: string[] = [];
  const ai: Ai = {
    generate: (_task, prompt) => {
      prompts.push(prompt);
      const r = reply(prompt);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve({ text: r, model: "m" });
    },
    embed: () => Promise.resolve([]),
  };
  return { ai, prompts };
}

Deno.test("looksEnglish detects English and other languages", () => {
  assertEquals(looksEnglish("Hi, the switcher is not showing on my store"), true);
  assertEquals(looksEnglish("ok"), true);
  assertEquals(looksEnglish("Bonjour, je veux un remboursement"), false);
  assertEquals(looksEnglish("Hallo, de vertaling werkt niet"), false);
  assertEquals(looksEnglish("Ich habe ein Problem mit der App"), false);
  assertEquals(looksEnglish("翻訳が表示されません"), false);
});

Deno.test("ensureEnglish marks English messages without calling AI", async () => {
  const { ai, prompts } = fakeAi(() => "{}");
  const saved: { id: number; content_en: string }[] = [];
  const out = await ensureEnglish([msg(1, "Hi, my currency is wrong")], ai, (r) => (saved.push(...r), Promise.resolve()));
  assertEquals(prompts.length, 0);
  assertEquals(saved, [{ id: 1, content_en: "Hi, my currency is wrong" }]);
  assertEquals(out[0].content_en, "Hi, my currency is wrong");
});

Deno.test("ensureEnglish translates non-English in one call", async () => {
  const { ai, prompts } = fakeAi(() => JSON.stringify({ items: [{ i: 0, en: "Hello" }, { i: 1, en: "I want a refund" }] }));
  const saved: { id: number; content_en: string }[] = [];
  const out = await ensureEnglish(
    [msg(1, "Bonjour tout le monde"), msg(2, "Je veux un remboursement")],
    ai,
    (r) => (saved.push(...r), Promise.resolve()),
  );
  assertEquals(prompts.length, 1);
  assertEquals(saved, [{ id: 1, content_en: "Hello" }, { id: 2, content_en: "I want a refund" }]);
  assertEquals(out.map((m) => m.content_en), ["Hello", "I want a refund"]);
});

Deno.test("ensureEnglish ignores operator, bot and already-translated messages", async () => {
  const { ai, prompts } = fakeAi(() => "{}");
  const saved: unknown[] = [];
  await ensureEnglish(
    [
      msg(1, "Bonjour", { from: "operator" }),
      msg(2, "Bonjour", { is_bot: true }),
      msg(3, "Bonjour", { content_en: "Hello" }),
      msg(4, "Bonjour", { type: "note" }),
    ],
    ai,
    (r) => (saved.push(...r), Promise.resolve()),
  );
  assertEquals(prompts.length, 0);
  assertEquals(saved, []);
});

Deno.test("ensureEnglish falls back to original when AI fails", async () => {
  const { ai } = fakeAi(() => new AiUnavailable());
  const out = await ensureEnglish([msg(1, "Je veux un remboursement")], ai, () => Promise.resolve());
  assertEquals(out[0].content_en, null);
  assertEquals(out[0].content, "Je veux un remboursement");
});
