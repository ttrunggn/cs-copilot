import { assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { makeDeps, TOKEN } from "./fakes.ts";

Deno.test("survey: gửi qua n8n gate, ghi trạng thái, lần hai không gửi lại", async () => {
  let recorded = false;
  let surveyCalls = 0;
  const { deps } = makeDeps({
    db: {
      getCsatSend: () => Promise.resolve(recorded ? { sent_by: "op-lan", sent_at: "2026-10-15T03:05:00+00:00" } : null),
      recordCsatSend: () => (recorded = true, Promise.resolve({ sent_at: "2026-10-15T03:05:00+00:00" })),
    },
  });
  deps.n8n.sendSurvey = () => (surveyCalls++, Promise.resolve(true));
  const req = { website_id: "ws1", session_id: "session_1", action: "survey" };
  const r1 = await handle(req, TOKEN, deps);
  assertEquals(r1.status, 200);
  assertEquals((r1.body as { sent: boolean; already: boolean }).sent, true);
  assertEquals((r1.body as { already: boolean }).already, false);
  const r2 = await handle(req, TOKEN, deps);
  assertEquals((r2.body as { already: boolean }).already, true);
  assertEquals(surveyCalls, 1); // chống gửi trùng
});

Deno.test("survey: n8n gate lỗi thì báo chưa gửi, không ghi trạng thái", async () => {
  const { deps } = makeDeps();
  deps.n8n.sendSurvey = () => Promise.resolve(false);
  const r = await handle({ website_id: "ws1", session_id: "session_1", action: "survey" }, TOKEN, deps);
  assertEquals((r.body as { sent: boolean }).sent, false);
});
