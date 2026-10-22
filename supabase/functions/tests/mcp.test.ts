import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleRpc, TOOLS } from "../mcp/handler.ts";
import { makeDeps, TOKEN } from "./fakes.ts";

const rpc = (method: string, params?: Record<string, unknown>, id: unknown = 1) => ({ jsonrpc: "2.0", id, method, params });

Deno.test("mcp initialize: trả protocol version + serverInfo", async () => {
  const { deps } = makeDeps();
  const r = await handleRpc(rpc("initialize", { protocolVersion: "2025-03-26" }), TOKEN, deps);
  assertEquals(r.status, 200);
  const body = r.body as { result: { protocolVersion: string; serverInfo: { name: string } } };
  assertEquals(body.result.protocolVersion, "2025-03-26");
  assertEquals(body.result.serverInfo.name, "cs-copilot");
});

Deno.test("mcp tools/list: đủ 5 tool, tên khớp action của copilot", async () => {
  const { deps } = makeDeps();
  const r = await handleRpc(rpc("tools/list"), TOKEN, deps);
  const body = r.body as { result: { tools: { name: string }[] } };
  assertEquals(body.result.tools.map((t) => t.name), [
    "copilot_check_conversation",
    "copilot_generate_draft",
    "copilot_analyze_sentiment",
    "copilot_handoff_note",
    "copilot_send_csat_survey",
  ]);
  assertEquals(TOOLS.length, 5);
});

Deno.test("mcp tools/call check: chạy qua handler copilot, trả structuredContent", async () => {
  const { deps } = makeDeps();
  const r = await handleRpc(
    rpc("tools/call", { name: "copilot_check_conversation", arguments: { website_id: "ws1", session_id: "session_1" } }),
    TOKEN,
    deps,
  );
  const body = r.body as { result: { isError: boolean; structuredContent: { action: string } } };
  assertEquals(body.result.isError, false);
  assertEquals(body.result.structuredContent.action, "check");
});

Deno.test("mcp tools/call: token sai → isError, không lộ chi tiết hệ thống", async () => {
  const { deps } = makeDeps();
  const r = await handleRpc(
    rpc("tools/call", { name: "copilot_check_conversation", arguments: { website_id: "ws1", session_id: "session_1" } }),
    "token-sai",
    deps,
  );
  const body = r.body as { result: { isError: boolean; content: { text: string }[] } };
  assertEquals(body.result.isError, true);
  assert(body.result.content[0].text.length > 0);
});

Deno.test("mcp: tool lạ → -32602, method lạ → -32601, notification → 202 im lặng", async () => {
  const { deps } = makeDeps();
  const badTool = await handleRpc(rpc("tools/call", { name: "khong_co", arguments: {} }), TOKEN, deps);
  assertEquals((badTool.body as { error: { code: number } }).error.code, -32602);
  const badMethod = await handleRpc(rpc("resources/list"), TOKEN, deps);
  assertEquals((badMethod.body as { error: { code: number } }).error.code, -32601);
  const notif = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, TOKEN, deps);
  assertEquals(notif.status, 202);
  assertEquals(notif.body, null);
});
