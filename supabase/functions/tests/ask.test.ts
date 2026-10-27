import { assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { mergeHybridChunks } from "../copilot/ask.ts";
import type { HelpdeskChunk } from "../_shared/types.ts";
import { fakeAi, makeDeps, TOKEN } from "./fakes.ts";

const REQ = { website_id: "ws1", session_id: "session_1", action: "ask", question: "Currency có tự đổi theo IP của khách không?" };
const HD: HelpdeskChunk = { title: "Currency", url: "https://help.transcy.io/en/article/currency", text: "Enable auto currency.", similarity: 0.8 };
const ANSWERED = JSON.stringify({ answered: true, answer: "Có. Bật Auto Currency trong Settings > Currency." });

type HybridImpl = (websiteId: string, query: string) => Promise<HelpdeskChunk[]>;

function setup(o: { hybrid?: HelpdeskChunk[]; hybridImpl?: HybridImpl; ask?: string; translate?: string } = {}) {
  const f = fakeAi({ ask: o.ask ?? ANSWERED, ...(o.translate !== undefined ? { translate: o.translate } : {}) });
  const captured: { queries: string[] } = { queries: [] };
  const impl: HybridImpl = o.hybridImpl ?? (() => Promise.resolve(o.hybrid ?? [{ ...HD, score: 0.03, ftsRank: 2 }]));
  const m = makeDeps({
    ai: f.ai,
    db: {
      hybridMatchHelpdesk: (ws: string, q: string) => { captured.queries.push(q); return impl(ws, q); },
    },
  });
  return { ...m, calls: f.calls, captured };
}

Deno.test("ask: bài trên sàn yếu phía vector (dưới ngưỡng chặt của generate, không khớp FTS) → vẫn đưa AI phán quyết; AI bảo không trả lời được → found false", async () => {
  const { deps, calls } = setup({
    hybrid: [{ ...HD, similarity: 0.5, score: 0.02, ftsRank: null }], // dưới 0.65, trên sàn yếu 0.45
    ask: JSON.stringify({ answered: false, answer: "" }),
  });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(r.body, { action: "ask", found: false, answer: null, sources: [] });
  assertEquals(calls.filter((c) => c.task === "ask").length, 1);
});

Deno.test("ask: bài dưới cả sàn yếu và không khớp FTS → found false, không gọi AI", async () => {
  const { deps, calls } = setup({ hybrid: [{ ...HD, similarity: 0.3, score: 0.01, ftsRank: null }] });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.body, { action: "ask", found: false, answer: null, sources: [] });
  assertEquals(calls.filter((c) => c.task === "ask" || c.task === "draft").length, 0);
});

Deno.test("ask: vector trượt hẳn nhưng FULL-TEXT khớp (hybrid) → AI trả lời được → found true (câu hỏi đời thường vẫn ra đáp án)", async () => {
  const { deps } = setup({ hybrid: [{ ...HD, similarity: 0, score: 0.016, ftsRank: 1 }] });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(r.body, {
    action: "ask",
    found: true,
    answer: "Có. Bật Auto Currency trong Settings > Currency.",
    sources: [{ title: "Currency", url: "https://help.transcy.io/en/article/currency" }],
  });
});

Deno.test("ask: không có bài nào khớp → found false, không gọi AI", async () => {
  const { deps, calls } = setup({ hybrid: [] });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.body, { action: "ask", found: false, answer: null, sources: [] });
  assertEquals(calls.filter((c) => c.task === "ask").length, 0);
});

Deno.test("ask: có bài qua ngưỡng + AI trả lời được → found true kèm đáp án và nguồn", async () => {
  const { deps, calls } = setup();
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(r.body, {
    action: "ask",
    found: true,
    answer: "Có. Bật Auto Currency trong Settings > Currency.",
    sources: [{ title: "Currency", url: "https://help.transcy.io/en/article/currency" }],
  });
  // Prompt phải chứa câu hỏi và nội dung bài helpdesk làm căn cứ.
  const p = calls.find((c) => c.task === "ask")!.prompt;
  assertEquals(p.includes("Currency có tự đổi theo IP"), true);
  assertEquals(p.includes("Enable auto currency."), true);
});

Deno.test("ask: AI nói bài không trả lời được → found false, không hiện đáp án", async () => {
  const { deps } = setup({ ask: JSON.stringify({ answered: false, answer: "" }) });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.body, { action: "ask", found: false, answer: null, sources: [] });
});

Deno.test("ask: output AI không phải JSON → found false, không hiện đáp án thiếu căn cứ", async () => {
  const { deps } = setup({ ask: "Theo mình thì cứ hứa hoàn tiền trong 30 ngày là được." });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.body, { action: "ask", found: false, answer: null, sources: [] });
});

Deno.test("ask: answered true nhưng đáp án rỗng → found false", async () => {
  const { deps } = setup({ ask: JSON.stringify({ answered: true, answer: "  " }) });
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.body, { action: "ask", found: false, answer: null, sources: [] });
});

Deno.test("ask: câu hỏi tiếng Việt (ca Ethan thử: 'khách muốn chặn bản dịch') → hybrid chạy cả bản dịch tiếng Anh; FTS khớp trên bản dịch → found true", async () => {
  const { deps, calls, captured } = setup({
    hybridImpl: (_ws, q) => Promise.resolve(
      q === "How to block translation for a page" ? [{ ...HD, similarity: 0, score: 0.016, ftsRank: 1 }] : [],
    ),
    translate: JSON.stringify({ items: [{ i: 0, en: "How to block translation for a page" }] }),
  });
  const r = await handle({ ...REQ, question: "khách muốn chặn bản dịch" }, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals((r.body as { found: boolean }).found, true);
  assertEquals(calls.filter((c) => c.task === "translate").length, 1);
  // Hybrid phải được gọi bằng bản dịch tiếng Anh (kho là tiếng Anh).
  assertEquals(captured.queries.includes("How to block translation for a page"), true);
});

Deno.test("ask: câu hỏi tiếng Anh thì KHÔNG tốn lượt dịch", async () => {
  const { deps, calls } = setup();
  const r = await handle({ ...REQ, question: "How do I enable auto currency by visitor IP?" }, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(calls.filter((c) => c.task === "translate").length, 0);
});

Deno.test("mergeHybridChunks: cùng đoạn từ hai biến thể thì giữ điểm RRF cao hơn; danh sách xếp theo điểm giảm dần", () => {
  const a: HelpdeskChunk = { ...HD, score: 0.01, ftsRank: null };
  const aBetter: HelpdeskChunk = { ...HD, score: 0.03, ftsRank: 1 };
  const b: HelpdeskChunk = { title: "Other", url: "https://x.io/o", text: "Other text.", similarity: 0.5, score: 0.02, ftsRank: null };
  const out = mergeHybridChunks([[a, b], [aBetter]]);
  assertEquals(out.length, 2);
  assertEquals(out[0].title, "Currency");
  assertEquals(out[0].score, 0.03);
  assertEquals(out[1].title, "Other");
});

Deno.test("ask: thiếu/rỗng câu hỏi → 400", async () => {
  const { deps } = setup();
  const r1 = await handle({ ...REQ, question: "   " }, TOKEN, deps);
  assertEquals(r1.status, 400);
  const { question: _q, ...noQuestion } = REQ;
  const r2 = await handle(noQuestion, TOKEN, deps);
  assertEquals(r2.status, 400);
});
