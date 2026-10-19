import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { acceptReply, bridgeState, insertMessage, newRequestId, PROTOCOL } from "./bridge-core.js";

Deno.test("insertMessage shape matches protocol 1", () => {
  assertEquals(insertMessage({ requestId: "r1", outputId: 9, sessionId: "session_1", text: "Hi", mode: "auto" }), {
    type: "copilot:insert", protocol: 1, request_id: "r1", output_id: 9, session_id: "session_1", text: "Hi", mode: "auto",
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

Deno.test("bridgeState missing / outdated / ready", () => {
  assertEquals(bridgeState(null), "missing");
  assertEquals(bridgeState({ type: "copilot:pong", protocol: 2 }), "outdated");
  assertEquals(bridgeState({ type: "copilot:pong", protocol: PROTOCOL, version: "1.0.0" }), "ready");
});
