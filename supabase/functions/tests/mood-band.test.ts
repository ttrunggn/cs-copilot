import { assertEquals } from "jsr:@std/assert@1";
import type { CrispClient } from "../_shared/crisp.ts";
import { moodBandForScore, syncMoodBand } from "../copilot/mood-band.ts";

Deno.test("moodBandForScore: ngưỡng dải theo bản thiết kế (12 đỏ · 38 cam · 61 đen · 86 xanh lá)", () => {
  assertEquals(moodBandForScore(12), "red");
  assertEquals(moodBandForScore(38), "orange");
  assertEquals(moodBandForScore(61), "black");
  assertEquals(moodBandForScore(86), "green");
  assertEquals(moodBandForScore(0), "red");
  assertEquals(moodBandForScore(24), "red");
  assertEquals(moodBandForScore(25), "orange");
  assertEquals(moodBandForScore(49), "orange");
  assertEquals(moodBandForScore(50), "black");
  assertEquals(moodBandForScore(74), "black");
  assertEquals(moodBandForScore(75), "green");
  assertEquals(moodBandForScore(100), "green");
  assertEquals(moodBandForScore(-5), "red"); // kẹp về [0,100]
  assertEquals(moodBandForScore(120), "green");
});

function fakeCrisp(initial: Record<string, unknown> | null, opts: { failGet?: boolean; failPatch?: boolean } = {}) {
  const patches: Record<string, unknown>[] = [];
  const crisp: CrispClient = {
    getConversationSegments: () => Promise.resolve([]),
    setConversationSegments: () => Promise.resolve(),
    getConversationCustomData: () => (opts.failGet ? Promise.reject(new Error("HTTP 500")) : Promise.resolve(initial)),
    setConversationCustomData: (_w, _s, data) => {
      if (opts.failPatch) return Promise.reject(new Error("HTTP 500"));
      patches.push(data);
      return Promise.resolve();
    },
  };
  return { crisp, patches };
}

Deno.test("syncMoodBand: chưa cấu hình Crisp → unconfigured, không gọi gì", async () => {
  assertEquals(await syncMoodBand({ crisp: null }, "ws1", "s1", 38), { status: "unconfigured" });
  assertEquals(await syncMoodBand({}, "ws1", "s1", 38), { status: "unconfigured" });
});

Deno.test("syncMoodBand: dải chưa đổi → unchanged, KHÔNG tốn lượt PATCH", async () => {
  const { crisp, patches } = fakeCrisp({ copilot_mood_band: "orange", shopify_domain: "a.myshopify.com" });
  const r = await syncMoodBand({ crisp }, "ws1", "s1", 38);
  assertEquals(r, { status: "unchanged", band: "orange" });
  assertEquals(patches, []);
});

Deno.test("syncMoodBand: dải đổi → PATCH object ĐÃ MERGE (giữ mọi key custom data khác)", async () => {
  const { crisp, patches } = fakeCrisp({ copilot_mood_band: "black", shopify_domain: "a.myshopify.com", plan: "pro" });
  const r = await syncMoodBand({ crisp }, "ws1", "s1", 90);
  assertEquals(r, { status: "updated", band: "green" });
  assertEquals(patches, [{ copilot_mood_band: "green", shopify_domain: "a.myshopify.com", plan: "pro" }]);
});

Deno.test("syncMoodBand: conversation chưa có custom data → PATCH chỉ key của mình", async () => {
  const { crisp, patches } = fakeCrisp(null);
  const r = await syncMoodBand({ crisp }, "ws1", "s1", 10);
  assertEquals(r, { status: "updated", band: "red" });
  assertEquals(patches, [{ copilot_mood_band: "red" }]);
});

Deno.test("syncMoodBand: Crisp lỗi (đọc hoặc ghi) → failed, KHÔNG throw ra ngoài", async () => {
  const a = fakeCrisp(null, { failGet: true });
  const r1 = await syncMoodBand({ crisp: a.crisp }, "ws1", "s1", 38);
  assertEquals(r1.status, "failed");
  const b = fakeCrisp({}, { failPatch: true });
  const r2 = await syncMoodBand({ crisp: b.crisp }, "ws1", "s1", 38);
  assertEquals(r2.status, "failed");
});

Deno.test("cách ly panel team: resolveSentiment KHÔNG syncBand → không một lời gọi ghi Crisp nào, dù có crisp client", async () => {
  const { resolveSentiment } = await import("../copilot/analyze.ts");
  const { fakeAi, makeDeps } = await import("./fakes.ts");
  let writes = 0;
  const crisp: CrispClient = {
    getConversationSegments: () => Promise.resolve([]),
    setConversationSegments: () => Promise.resolve(),
    getConversationCustomData: () => Promise.resolve({}),
    setConversationCustomData: () => {
      writes++;
      return Promise.resolve();
    },
  };
  const { ai } = fakeAi({
    sentiment: JSON.stringify({ score: 30, mood: "frustrated", urgency: "high", confidence: 0.9, summary: "Khách đang bực vì lỗi dịch", signals: [], issues: [] }),
  });
  const { deps } = makeDeps({ ai });
  const messages = await deps.db.getMessages("ws1", "session_1", 40);
  // Đường panel (analyze/generate) không truyền syncBand:
  const r1 = await resolveSentiment({ db: deps.db, ai: deps.ai, crisp }, "ws1", "session_1", messages, true, "analyze");
  assertEquals(Boolean(r1.sentiment), true);
  assertEquals(writes, 0);
  // Đường được phép (precompute/native) có truyền cờ:
  const r2 = await resolveSentiment({ db: deps.db, ai: deps.ai, crisp, syncBand: true }, "ws1", "session_1", messages, true, "precompute");
  assertEquals(Boolean(r2.sentiment), true);
  assertEquals(writes, 1);
});
