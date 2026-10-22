import { assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import type { HelpdeskChunk } from "../_shared/types.ts";
import { fakeAi, makeDeps, TOKEN } from "./fakes.ts";

const REQ = { website_id: "ws1", session_id: "session_1", action: "ask", question: "Currency có tự đổi theo IP của khách không?" };
const HD: HelpdeskChunk = { title: "Currency", url: "https://help.transcy.io/en/article/currency", text: "Enable auto currency.", similarity: 0.8 };
const ANSWERED = JSON.stringify({ answered: true, answer: "Có. Bật Auto Currency trong Settings > Currency." });

function setup(o: { helpdesk?: HelpdeskChunk[]; ask?: string } = {}) {
  const f = fakeAi({ ask: o.ask ?? ANSWERED });
  const m = makeDeps({
    ai: f.ai,
    db: { matchHelpdesk: () => Promise.resolve(o.helpdesk ?? [HD]) },
  });
  return { ...m, calls: f.calls };
}

Deno.test("ask: không có bài nào qua ngưỡng similarity → found false và không gọi AI sinh đáp án", async () => {
  const { deps, calls } = setup({ helpdesk: [{ ...HD, similarity: 0.5 }] }); // dưới ngưỡng 0.65 của generate
  const r = await handle(REQ, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(r.body, { action: "ask", found: false, answer: null, sources: [] });
  // Chỉ được phép gọi embed để truy hồi; tuyệt đối không gọi task ask/draft.
  assertEquals(calls.filter((c) => c.task === "ask" || c.task === "draft").length, 0);
});

Deno.test("ask: không có bài nào khớp → found false, không gọi AI", async () => {
  const { deps, calls } = setup({ helpdesk: [] });
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

Deno.test("ask: thiếu/rỗng câu hỏi → 400", async () => {
  const { deps } = setup();
  const r1 = await handle({ ...REQ, question: "   " }, TOKEN, deps);
  assertEquals(r1.status, 400);
  const { question: _q, ...noQuestion } = REQ;
  const r2 = await handle(noQuestion, TOKEN, deps);
  assertEquals(r2.status, 400);
});
