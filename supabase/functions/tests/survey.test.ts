import { assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { makeDeps, TOKEN } from "./fakes.ts";

/**
 * Fake csat_survey_sends có trạng thái, mô phỏng đúng PK (website, session):
 * recordCsatSend = claim — dòng đã tồn tại thì trả null (ignoreDuplicates),
 * releaseCsatSend = xoá dòng. Nhờ vậy test tái hiện được cả race đồng thời.
 */
function fakeCsatDb() {
  let row: { sent_by: string; sent_at: string } | null = null;
  return {
    row: () => row,
    setRow: (v: { sent_by: string; sent_at: string } | null) => { row = v; },
    db: {
      getCsatSend: () => Promise.resolve(row),
      recordCsatSend: () => {
        if (row) return Promise.resolve(null);
        row = { sent_by: "op-jamie", sent_at: new Date().toISOString() };
        return Promise.resolve({ sent_at: row.sent_at });
      },
      releaseCsatSend: () => (row = null, Promise.resolve()),
    },
  };
}

Deno.test("survey: gửi qua n8n gate, ghi trạng thái, bấm lại NGAY thì không gửi trùng (cửa sổ chống bấm đúp)", async () => {
  const csat = fakeCsatDb();
  let surveyCalls = 0;
  const { deps } = makeDeps({ db: csat.db });
  deps.n8n.sendSurvey = () => (surveyCalls++, Promise.resolve(true));
  const req = { website_id: "ws1", session_id: "session_1", action: "survey" };
  const r1 = await handle(req, TOKEN, deps);
  assertEquals(r1.status, 200);
  assertEquals((r1.body as { sent: boolean; already: boolean }).sent, true);
  assertEquals((r1.body as { already: boolean }).already, false);
  const r2 = await handle(req, TOKEN, deps);
  assertEquals((r2.body as { already: boolean }).already, true);
  assertEquals(surveyCalls, 1); // chống gửi trùng trong cửa sổ guard
});

Deno.test("survey: đã gửi từ lâu (ngoài cửa sổ chống trùng) thì bấm là GỬI LẠI thật — nút không bị khoá vĩnh viễn", async () => {
  const csat = fakeCsatDb();
  csat.setRow({ sent_by: "op-jamie", sent_at: new Date(Date.now() - 10 * 60_000).toISOString() });
  let surveyCalls = 0;
  const { deps } = makeDeps({ db: csat.db });
  deps.n8n.sendSurvey = () => (surveyCalls++, Promise.resolve(true));
  const req = { website_id: "ws1", session_id: "session_1", action: "survey" };
  const r = await handle(req, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals((r.body as { sent: boolean; already: boolean }).sent, true);
  assertEquals((r.body as { already: boolean }).already, false);
  assertEquals(surveyCalls, 1); // gửi lại thật qua n8n
  // Claim mới mang mốc thời gian mới (không còn kẹt ở lần gửi 10 phút trước).
  assertEquals(Date.now() - Date.parse(csat.row()!.sent_at) < 30_000, true);
});

Deno.test("survey: hai request ĐỒNG THỜI chỉ gửi đúng một lần (claim trước khi gửi)", async () => {
  const csat = fakeCsatDb();
  let surveyCalls = 0;
  const { deps } = makeDeps({ db: csat.db });
  // n8n chậm 30ms: cả hai request đều kịp qua bước kiểm "đã gửi chưa" trước
  // khi lượt gửi đầu xong — bản cũ (kiểm → gửi → ghi) sẽ gửi 2 lần ở đây.
  deps.n8n.sendSurvey = () => (surveyCalls++, new Promise<boolean>((r) => setTimeout(() => r(true), 30)));
  const req = { website_id: "ws1", session_id: "session_1", action: "survey" };
  const [r1, r2] = await Promise.all([handle(req, TOKEN, deps), handle(req, TOKEN, deps)]);
  assertEquals(surveyCalls, 1);
  const bodies = [r1.body, r2.body] as { sent: boolean; already: boolean }[];
  assertEquals(bodies.every((b) => b.sent), true);
  assertEquals(bodies.filter((b) => b.already).length, 1); // một thắng claim, một nhận "đã gửi"
});

Deno.test("survey: n8n gate lỗi thì báo chưa gửi kèm lý do và NHẢ claim để bấm lại được", async () => {
  const csat = fakeCsatDb();
  const { deps } = makeDeps({ db: csat.db });
  deps.n8n.sendSurvey = () => Promise.resolve(false);
  const req = { website_id: "ws1", session_id: "session_1", action: "survey" };
  const r = await handle(req, TOKEN, deps);
  const body = r.body as { sent: boolean; error: string | null };
  assertEquals(body.sent, false);
  assertEquals(body.error?.includes("n8n gate"), true);
  assertEquals(csat.row(), null); // claim đã nhả — không kẹt ở trạng thái "đã gửi" giả
  deps.n8n.sendSurvey = () => Promise.resolve(true);
  const r2 = await handle(req, TOKEN, deps);
  assertEquals((r2.body as { sent: boolean }).sent, true);
});

Deno.test("survey: tên gửi đi là tên ACCOUNT Crisp (operator_name), thắng tên trong DB", async () => {
  const csat = fakeCsatDb();
  const { deps } = makeDeps({ db: csat.db });
  let agentName = "";
  deps.n8n.sendSurvey = (_w, _s, name) => (agentName = name, Promise.resolve(true));
  // makeDeps mặc định getOperator trả "Jamie Lee" (bản sao DB); request mang
  // operator_name của account đang đăng nhập thì tên đó phải thắng.
  const r = await handle({ website_id: "ws1", session_id: "session_1", action: "survey", operator_name: "Jamie L. (account)" }, TOKEN, deps);
  assertEquals(r.status, 200);
  assertEquals(agentName, "Jamie L. (account)");
});
