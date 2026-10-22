// Cổng MCP (Model Context Protocol) cho CS Copilot.
//
// Mở 5 action sẵn có của copilot thành MCP tools để các AI client nội bộ
// (chatbot trainer, agent khác, MCP Inspector…) gọi được mà không phải biết
// REST nội bộ. Không chứa logic nghiệp vụ mới: tools/call uỷ thác thẳng cho
// handler của copilot nên auth (token CS cá nhân), validate và hành vi giữ
// nguyên như widget đang dùng.
//
// Giao thức: JSON-RPC 2.0 qua HTTP POST (Streamable HTTP, stateless).
// Method hỗ trợ: initialize, ping, tools/list, tools/call. Notification
// (thiếu id) được chấp nhận và không trả nội dung (HTTP 202 ở tầng index).
import { type Deps, handle as copilotHandle } from "../copilot/handler.ts";

export const PROTOCOL_VERSION = "2025-03-26";
export const SERVER_INFO = { name: "cs-copilot", version: "1.0.0" };

const ID_PROPS = {
  website_id: { type: "string", description: "Crisp website_id của workspace" },
  session_id: { type: "string", description: "Crisp session_id của conversation, dạng session_…" },
};
const FORCE_PROP = {
  force: { type: "boolean", description: "true = tính lại từ đầu, bỏ qua cache" },
};

export const TOOLS = [
  {
    name: "copilot_check_conversation",
    description:
      "Đọc trạng thái một conversation Crisp: tin khách chưa trả lời, topic, giọng CS sẽ dùng, ticket Jira liên quan, sentiment đã cache và trạng thái CSAT survey. Chỉ đọc, không gọi AI.",
    inputSchema: { type: "object", properties: { ...ID_PROPS }, required: ["website_id", "session_id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "copilot_generate_draft",
    description:
      "Soạn draft trả lời khách theo giọng của CS đang đăng nhập (token), đã đối chiếu helpdesk và chỉnh theo tâm trạng khách (sentiment Layer 2). Trả draft kèm cảnh báo cần kiểm tra; KHÔNG tự gửi cho khách.",
    inputSchema: { type: "object", properties: { ...ID_PROPS, ...FORCE_PROP }, required: ["website_id", "session_id"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "copilot_analyze_sentiment",
    description:
      "Phân tích tâm trạng khách từ đoạn chat: điểm 0-100, mood (frustrated/confused/neutral/satisfied/happy), urgency (low/medium/high) và độ tin cậy. Kết quả được cache theo tin nhắn của khách.",
    inputSchema: { type: "object", properties: { ...ID_PROPS, ...FORCE_PROP }, required: ["website_id", "session_id"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "copilot_handoff_note",
    description:
      "Tạo private note bàn giao (handoff) cho conversation và đăng vào Crisp qua n8n. Có side-effect thật trong Crisp nên chỉ gọi khi CS yêu cầu.",
    inputSchema: { type: "object", properties: { ...ID_PROPS, ...FORCE_PROP }, required: ["website_id", "session_id"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "copilot_send_csat_survey",
    description:
      "Gửi CSAT survey (picker 4 lựa chọn) vào conversation cho khách qua n8n gate. Server chống gửi trùng: conversation đã gửi rồi sẽ trả already=true thay vì gửi lại.",
    inputSchema: { type: "object", properties: { ...ID_PROPS }, required: ["website_id", "session_id"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
] as const;

const TOOL_ACTIONS: Record<string, string> = {
  copilot_check_conversation: "check",
  copilot_generate_draft: "generate",
  copilot_analyze_sentiment: "analyze",
  copilot_handoff_note: "handoff",
  copilot_send_csat_survey: "survey",
};

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const result = (id: RpcRequest["id"], value: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: value });
const failure = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function callTool(req: RpcRequest, token: string, deps: Deps): Promise<unknown> {
  const name = typeof req.params?.name === "string" ? req.params.name : "";
  const action = TOOL_ACTIONS[name];
  if (!action) return failure(req.id, -32602, `Tool không tồn tại: ${name || "(thiếu name)"}`);
  const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  if (!str("website_id") || !str("session_id")) {
    return failure(req.id, -32602, "Thiếu website_id hoặc session_id");
  }
  const r = await copilotHandle(
    { website_id: str("website_id"), session_id: str("session_id"), action, force: args.force === true },
    token,
    deps,
  );
  if (r.status >= 400) {
    const message = (r.body as { error?: string })?.error ?? `copilot trả lỗi ${r.status}`;
    // Lỗi nghiệp vụ của tool (hết quota, không tìm thấy conversation…) đi vào
    // content với isError để client hiển thị cho người dùng, không phải lỗi giao thức.
    return result(req.id, { content: [{ type: "text", text: message }], isError: true });
  }
  return result(req.id, {
    content: [{ type: "text", text: JSON.stringify(r.body, null, 2) }],
    structuredContent: r.body,
    isError: false,
  });
}

async function dispatch(req: RpcRequest, token: string, deps: Deps): Promise<unknown> {
  switch (req.method) {
    case "initialize": {
      const clientVersion = typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : PROTOCOL_VERSION;
      return result(req.id, {
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return result(req.id, {});
    case "tools/list":
      return result(req.id, { tools: TOOLS });
    case "tools/call":
      return await callTool(req, token, deps);
    default:
      return failure(req.id, -32601, `Method không hỗ trợ: ${req.method ?? "(thiếu method)"}`);
  }
}

/**
 * Xử lý một body JSON-RPC (đơn lẻ hoặc batch). Trả null khi toàn bộ là
 * notification — tầng HTTP đáp 202 không nội dung theo đặc tả MCP.
 */
export async function handleRpc(body: unknown, token: string, deps: Deps): Promise<{ status: number; body: unknown }> {
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const item of body) {
      const r = await handleRpc(item, token, deps);
      if (r.body !== null) out.push(r.body);
    }
    return out.length ? { status: 200, body: out } : { status: 202, body: null };
  }
  if (typeof body !== "object" || body === null) {
    return { status: 400, body: failure(null, -32600, "Body phải là JSON-RPC object") };
  }
  const req = body as RpcRequest;
  const isNotification = req.id === undefined || (typeof req.method === "string" && req.method.startsWith("notifications/"));
  if (isNotification) {
    // Notification không có response; lỗi trong notification cũng nuốt theo đặc tả.
    try {
      await dispatch(req, token, deps);
    } catch { /* bỏ qua */ }
    return { status: 202, body: null };
  }
  try {
    return { status: 200, body: await dispatch(req, token, deps) };
  } catch (e) {
    console.error("mcp error", e);
    return { status: 200, body: failure(req.id, -32603, "Lỗi nội bộ cổng MCP") };
  }
}
