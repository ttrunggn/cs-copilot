import { assertEquals } from "jsr:@std/assert@1";
import { handle } from "../copilot/handler.ts";
import { sha256Hex } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { N8n } from "../_shared/n8n.ts";
import type { ConversationRow, MessageRow, ProfileRow, Workspace } from "../_shared/types.ts";

const WS: Workspace = {
  website_id: "ws1",
  name: "App A",
  topics: [{ key: "billing", label: "Billing", segments: ["billing"] }],
  default_profile: {},
};
const CONV: ConversationRow = {
  website_id: "ws1",
  session_id: "session_1",
  customer_email: "k@x.io",
  customer_name: "Khách",
  topic: "billing",
  topic_source: "segment",
  state: "unresolved",
  last_customer_at: "2026-10-15T03:03:00+00:00",
  last_human_operator_at: "2026-10-15T03:02:00+00:00",
};
const MSGS: MessageRow[] = [
  { from: "user", type: "text", is_bot: false, content: "a", created_at: "2026-10-15T03:01:00+00:00", operator_name: null },
  { from: "operator", type: "text", is_bot: false, content: "b", created_at: "2026-10-15T03:02:00+00:00", operator_name: "Lan" },
  { from: "user", type: "text", is_bot: false, content: "c", created_at: "2026-10-15T03:03:00+00:00", operator_name: null },
];
const PROFILES: ProfileRow[] = [
  { crisp_user_id: "op-lan", website_id: "ws1", topic: "billing", tone: "chi tiết", conversations_used: 9, learned_at: null, manual_override: null },
];

const TOKEN = "tok-lan";
const TOKEN_HASH = await sha256Hex(TOKEN);

function deps(over: Partial<Db> = {}, stale = false) {
  const db: Db = {
    getWorkspace: () => Promise.resolve(WS),
    getOperatorIdByTokenHash: (h) => Promise.resolve(h === TOKEN_HASH ? "op-lan" : null),
    isOperatorMember: () => Promise.resolve(true),
    getConversation: () => Promise.resolve(CONV),
    getMessages: () => Promise.resolve(MSGS),
    getProfiles: () => Promise.resolve(PROFILES),
    getOperator: () => Promise.resolve({ display_name: "Lan Nguyen" }),
    ...over,
  };
  const n8n: N8n = {
    refreshConversation: () => Promise.resolve({ stale }),
    postNote: () => Promise.resolve(true),
  };
  return { db, n8n };
}

const REQ = { website_id: "ws1", session_id: "session_1", action: "check" };

Deno.test("check returns unanswered, topic and profile", async () => {
  const r = await handle(REQ, TOKEN, deps());
  assertEquals(r.status, 200);
  assertEquals(r.body, {
    action: "check",
    stale: false,
    workspace: "App A",
    topic: "billing",
    topic_label: "Billing",
    profile_source: "topic",
    profile_name: "Lan Nguyen",
    needs_reply: true,
    unanswered: ["c"],
    last_customer_at: CONV.last_customer_at,
    last_human_operator_at: CONV.last_human_operator_at,
    jira: [],
  });
});

Deno.test("check passes through stale flag", async () => {
  const r = await handle(REQ, TOKEN, deps({}, true));
  assertEquals((r.body as { stale: boolean }).stale, true);
});

Deno.test("unknown action -> 400", async () => {
  assertEquals((await handle({ ...REQ, action: "delete" }, TOKEN, deps())).status, 400);
});

Deno.test("handoff not available yet -> 501", async () => {
  assertEquals((await handle({ ...REQ, action: "handoff" }, TOKEN, deps())).status, 501);
});

Deno.test("missing session_id -> 400", async () => {
  assertEquals((await handle({ ...REQ, session_id: "" }, TOKEN, deps())).status, 400);
});

Deno.test("non-object body -> 400", async () => {
  assertEquals((await handle("nope", TOKEN, deps())).status, 400);
});

Deno.test("conversation not in DB -> 404", async () => {
  assertEquals((await handle(REQ, TOKEN, deps({ getConversation: () => Promise.resolve(null) }))).status, 404);
});

Deno.test("bad token -> 401", async () => {
  assertEquals((await handle(REQ, "wrong!", deps())).status, 401);
});

Deno.test("unexpected error -> 500 without leaking details", async () => {
  const r = await handle(REQ, TOKEN, deps({ getMessages: () => Promise.reject(new Error("db password=xyz")) }));
  assertEquals(r.status, 500);
  assertEquals(r.body, { error: "Lỗi hệ thống, thử lại sau" });
});
