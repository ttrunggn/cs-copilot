import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { acceptReply, bridgeState, draftInsert, insertMessage, newRequestId, PROTOCOL } from "./bridge-core.js";

Deno.test("insertMessage shape matches protocol 2 with reply target by default", () => {
  assertEquals(insertMessage({ requestId: "r1", outputId: 9, sessionId: "session_1", text: "Hi", mode: "auto" }), {
    type: "copilot:insert", protocol: 2, request_id: "r1", output_id: 9, session_id: "session_1", text: "Hi", mode: "auto", target: "reply",
  });
});

Deno.test("insertMessage carries the note target for private notes", () => {
  assertEquals(insertMessage({ requestId: "r2", outputId: "note-x", sessionId: "session_1", text: "Note nội bộ", mode: "auto", target: "note" }), {
    type: "copilot:insert", protocol: 2, request_id: "r2", output_id: "note-x", session_id: "session_1", text: "Note nội bộ", mode: "auto", target: "note",
  });
});

Deno.test("newRequestId is unique", () => {
  assertNotEquals(newRequestId(), newRequestId());
});

Deno.test("acceptReply takes the matching insert_result from this window", () => {
  const win = {};
  const ev = { source: win, data: { type: "copilot:insert_result", request_id: "r1", status: "inserted" } };
  assertEquals(acceptReply(ev, win, "r1"), ev.data);
});

Deno.test("acceptReply drops other source, wrong request_id and our own outgoing messages", () => {
  const win = {};
  assertEquals(acceptReply({ source: {}, data: { type: "copilot:insert_result", request_id: "r1" } }, win, "r1"), null);
  assertEquals(acceptReply({ source: win, data: { type: "copilot:insert_result", request_id: "old" } }, win, "r1"), null);
  assertEquals(acceptReply({ source: win, data: { type: "copilot:insert", request_id: "r1" } }, win, "r1"), null);
});

Deno.test("bridgeState missing / outdated / ready — extension protocol 1 bị coi là outdated vì chưa biết target note", () => {
  assertEquals(bridgeState(null), "missing");
  assertEquals(bridgeState({ type: "copilot:pong", protocol: 1 }), "outdated");
  assertEquals(bridgeState({ type: "copilot:pong", protocol: PROTOCOL, version: "1.1.0" }), "ready");
});

Deno.test("draftInsert uses the draft's own session and refuses another conversation", () => {
  const draft = { output_id: 9, session_id: "session_A", vm: { text: "Hi" } };
  assertEquals(draftInsert(draft, "session_B", "r1", "auto"), null);
  assertEquals(draftInsert(draft, "session_A", "r1", "auto"), {
    type: "copilot:insert", protocol: 2, request_id: "r1", output_id: 9, session_id: "session_A", text: "Hi", mode: "auto", target: "reply",
  });
  assertEquals(draftInsert(null, "session_A", "r1", "auto"), null);
});

Deno.test("khoá chống lệch protocol: extension/bridge.js khai báo đúng PROTOCOL của widget", async () => {
  // PROTOCOL tồn tại ở 2 nơi độc lập (widget/bridge-core.js và hằng số trong
  // extension/bridge.js — build chỉ gộp composer-core, không gộp bridge-core).
  // Một phía bump mà phía kia quên là widget báo outdated oan hoặc ngược lại
  // cho điền note bằng extension không hiểu target — test này giữ chúng khớp.
  const bridgeSrc = await Deno.readTextFile(new URL("../extension/bridge.js", import.meta.url));
  const m = bridgeSrc.match(/const PROTOCOL = (\d+)/);
  assertEquals(m?.[1], String(PROTOCOL));
  const manifest = JSON.parse(await Deno.readTextFile(new URL("../extension/manifest.template.json", import.meta.url)));
  assertEquals(typeof manifest.version, "string"); // version extension đi kèm pong cho chẩn đoán
});
