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

Deno.test("embed skips failing article and continues", async () => {
  const { s, replaced } = store([A(1, "Bad"), A(2, "Good")]);
  const r = await handleEmbed(SECRET, { store: s, ai: ai("Bad"), secret: SECRET });
  assertEquals((r.body as { embedded: number }).embedded, 1);
  assertEquals(replaced.map((x) => x.id), [2]);
});

/** Store có trạng thái: bài embed xong thì rời hàng đợi, như view helpdesk_pending_articles. */
function queue(n: number) {
  const pending = Array.from({ length: n }, (_, i) => A(i + 1, `Art${i + 1}`));
  const s: HelpdeskStore = {
    pendingArticles: (limit) => Promise.resolve(pending.slice(0, limit)),
    countPending: () => Promise.resolve(pending.length),
    replaceChunks: (id) => {
      pending.splice(pending.findIndex((a) => a.id === id), 1);
      return Promise.resolve();
    },
  };
  return s;
}

Deno.test("embed keeps going past one batch within the time budget", async () => {
  const r = await handleEmbed(SECRET, { store: queue(45), ai: ai(), secret: SECRET, batch: 20 });
  assertEquals(r.body, { embedded: 45, remaining: 0 });
});

Deno.test("embed stops when the time budget is used up", async () => {
  let t = 0;
  const r = await handleEmbed(SECRET, { store: queue(45), ai: ai(), secret: SECRET, batch: 20, budgetMs: 1000, now: () => (t += 600) });
  assertEquals((r.body as { embedded: number }).embedded, 20);
});

Deno.test("an article that keeps failing does not block the rest of the queue", async () => {
  const r = await handleEmbed(SECRET, { store: queue(30), ai: ai("Art1 body"), secret: SECRET, batch: 5 });
  assertEquals(r.body, { embedded: 29, remaining: 1 });
});
