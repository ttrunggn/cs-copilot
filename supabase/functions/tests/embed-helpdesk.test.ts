import { assertEquals } from "jsr:@std/assert@1";
import { handleEmbed, type HelpdeskStore } from "../embed-helpdesk/handler.ts";
import type { Ai } from "../_shared/gemini.ts";

const SECRET = "s".repeat(40);

function store(articles: { id: number; title: string; content_md: string; content_hash: string }[], remainingAfter = 0) {
  const replaced: { id: number; hash: string; n: number }[] = [];
  const s: HelpdeskStore = {
    pendingArticles: (limit) => Promise.resolve(articles.slice(0, limit)),
    countPending: () => Promise.resolve(remainingAfter),
    replaceChunks: (id, hash, chunks) => (replaced.push({ id, hash, n: chunks.length }), Promise.resolve()),
  };
  return { s, replaced };
}

function ai(failOn?: string): Ai {
  return {
    generate: () => Promise.reject(new Error("unused")),
    embed: (texts) => texts.some((t) => failOn && t.includes(failOn)) ? Promise.reject(new Error("boom")) : Promise.resolve(texts.map(() => [0.1])),
  };
}

const A = (id: number, title: string) => ({ id, title, content_md: `${title} body`, content_hash: `h${id}` });

Deno.test("embed rejects wrong secret", async () => {
  const r = await handleEmbed("nope", { store: store([]).s, ai: ai(), secret: SECRET });
  assertEquals(r.status, 401);
});

Deno.test("embed rejects placeholder secret", async () => {
  const r = await handleEmbed("REPLACE_N8N_SHARED_SECRET", { store: store([]).s, ai: ai(), secret: "REPLACE_N8N_SHARED_SECRET" });
  assertEquals(r.status, 401);
});

Deno.test("embed processes pending articles and reports remaining", async () => {
  const { s, replaced } = store([A(1, "One"), A(2, "Two")], 5);
  const r = await handleEmbed(SECRET, { store: s, ai: ai(), secret: SECRET });
  assertEquals(r, { status: 200, body: { embedded: 2, remaining: 5 } });
  assertEquals(replaced, [{ id: 1, hash: "h1", n: 1 }, { id: 2, hash: "h2", n: 1 }]);
});

Deno.test("embed respects the batch size", async () => {
  const { s, replaced } = store([A(1, "One"), A(2, "Two"), A(3, "Three")]);
  await handleEmbed(SECRET, { store: s, ai: ai(), secret: SECRET, batch: 2 });
  assertEquals(replaced.length, 2);
});

Deno.test("embed skips failing article and continues", async () => {
  const { s, replaced } = store([A(1, "Bad"), A(2, "Good")]);
  const r = await handleEmbed(SECRET, { store: s, ai: ai("Bad"), secret: SECRET });
  assertEquals((r.body as { embedded: number }).embedded, 1);
  assertEquals(replaced.map((x) => x.id), [2]);
});
