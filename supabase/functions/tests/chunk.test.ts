import { assertEquals } from "jsr:@std/assert@1";
import { chunkMarkdown } from "../_shared/chunk.ts";

Deno.test("chunkMarkdown short article is one chunk", () => {
  assertEquals(chunkMarkdown("Title", "Para one.\n\nPara two."), ["Title\n\nPara one.\n\nPara two."]);
});

Deno.test("chunkMarkdown splits long article under limit", () => {
  const para = "Sentence number one is here. ".repeat(20).trim(); // ~580 ký tự
  const md = Array.from({ length: 6 }, () => para).join("\n\n");
  const chunks = chunkMarkdown("T", md, 1200);
  assertEquals(chunks.length > 1, true);
  for (const c of chunks) {
    assertEquals(c.startsWith("T\n\n"), true);
    assertEquals(c.length <= 1200 + "T\n\n".length, true, `chunk length ${c.length}`);
  }
});

Deno.test("chunkMarkdown splits a single huge paragraph by sentence, then hard cut", () => {
  const sentences = "Short sentence. ".repeat(200).trim();
  const noBreaks = "x".repeat(3000);
  for (const md of [sentences, noBreaks]) {
    const chunks = chunkMarkdown("T", md, 1000);
    assertEquals(chunks.length >= 3, true);
    for (const c of chunks) assertEquals(c.length <= 1000 + 3, true);
  }
});

Deno.test("chunkMarkdown never emits empty chunk", () => {
  assertEquals(chunkMarkdown("T", "\n\n\n   \n\n"), []);
  for (const c of chunkMarkdown("T", "a\n\n\n\n\nb")) assertEquals(c.replace("T\n\n", "").trim() !== "", true);
});
