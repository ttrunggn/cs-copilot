# Cổng MCP của CS Copilot

Edge Function `mcp` mở các khả năng của copilot thành **MCP tools** (Model
Context Protocol, Streamable HTTP) để AI client nội bộ — chatbot trainer,
agent khác, MCP Inspector — gọi trực tiếp, không cần biết REST nội bộ.

Endpoint sau khi deploy:

```
POST https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/mcp
```

## Xác thực

Dùng đúng token CS cá nhân như khi gọi function `copilot`, gửi qua một trong
hai header:

- `x-copilot-token: <token>`, hoặc
- `Authorization: Bearer <token>`

Tool chạy với quyền và giọng văn của CS sở hữu token đó.

## Tools

| Tool | Việc | Side-effect |
| --- | --- | --- |
| `copilot_check_conversation` | Trạng thái conversation: tin chưa trả lời, topic, Jira, sentiment đã cache, trạng thái CSAT | Không (chỉ đọc) |
| `copilot_generate_draft` | Soạn draft theo giọng CS + sentiment Layer 2, kèm cảnh báo verify | Ghi output vào DB, không gửi khách |
| `copilot_analyze_sentiment` | Điểm mood 0-100, mood, urgency, confidence (cache theo tin khách) | Ghi cache sentiment |
| `copilot_handoff_note` | Tạo và đăng private note bàn giao vào Crisp | Có — đăng note thật |
| `copilot_send_csat_survey` | Gửi CSAT picker 4 lựa chọn vào conversation | Có — gửi cho khách, server chống trùng |

Mọi tool đều nhận `website_id` và `session_id` (dạng `session_…`);
`generate`/`analyze`/`handoff` nhận thêm `force` để bỏ qua cache.

## Ví dụ cấu hình client (stdio-style JSON)

```json
{
  "mcpServers": {
    "cs-copilot": {
      "url": "https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/mcp",
      "headers": { "x-copilot-token": "<token CS cá nhân>" }
    }
  }
}
```

## Kiểm tra nhanh bằng curl

```bash
curl -s $MCP_URL -H "x-copilot-token: $TOKEN" -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "tools/list"
}'
```

```bash
curl -s $MCP_URL -H "x-copilot-token: $TOKEN" -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "copilot_check_conversation",
              "arguments": { "website_id": "<website_id>", "session_id": "session_…" } }
}'
```

Lỗi nghiệp vụ (sai token, không thấy conversation, AI hết quota) trả về trong
`result` với `isError: true` để client hiển thị cho người dùng; lỗi giao thức
trả JSON-RPC error chuẩn (`-32601` method lạ, `-32602` sai tham số).
