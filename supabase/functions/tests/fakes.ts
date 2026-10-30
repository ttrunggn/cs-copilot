// Dependency giả dùng chung cho test handler/handoff/generate.
import { sha256Hex } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { Ai, AiTask } from "../_shared/gemini.ts";
import type { N8n } from "../_shared/n8n.ts";
import type { ConversationRow, MessageRow, NewOutput, OutputRow, Workspace } from "../_shared/types.ts";

export const TOKEN = "tok-lan";
export const TOKEN_HASH = await sha256Hex(TOKEN);

export const WS: Workspace = {
  website_id: "ws1",
  name: "App A",
  topics: [
    { key: "billing", label: "Thanh toán & gói", segments: ["billing"] },
    { key: "translation", label: "Dịch nội dung", segments: [] },
  ],
  default_profile: {},
  jira_project: null,
  storefront_watch: false,
  review_link: null,
};

export const CONV: ConversationRow = {
  website_id: "ws1",
  session_id: "session_1",
  customer_email: "k@x.io",
  customer_name: "Khách",
  topic: "billing",
  topic_source: "segment",
  state: "unresolved",
  last_customer_at: "2026-10-15T03:03:00+00:00",
  last_human_operator_at: "2026-10-15T03:02:00+00:00",
  updated_at: "2026-10-15T03:03:00+00:00",
  custom_data: {},
};

let id = 100;
export function msg(from: "user" | "operator", content: string, minute: number, extra: Partial<MessageRow> = {}): MessageRow {
  return {
    id: id++,
    content_en: null,
    from,
    type: "text",
    is_bot: false,
    content,
    created_at: `2026-10-15T03:${String(minute).padStart(2, "0")}:00+00:00`,
    operator_name: from === "operator" ? "Lan" : null,
    ...extra,
  };
}

export type AiReply = string | Error;

/** AI giả: trả lời theo task, ghi lại prompt từng lần gọi. */
export function fakeAi(replies: Partial<Record<AiTask, AiReply | ((prompt: string) => AiReply)>>, embedding: number[] | Error = [0.1]) {
  const calls: { task: AiTask; prompt: string; opts?: { schema?: Record<string, unknown>; temperature?: number } }[] = [];
  const ai: Ai = {
    generate(task, prompt, opts) {
      calls.push({ task, prompt, opts });
      const r = replies[task];
      const v = typeof r === "function" ? r(prompt) : r;
      if (v === undefined) return Promise.reject(new Error(`unexpected ai task ${task}`));
      return v instanceof Error ? Promise.reject(v) : Promise.resolve({ text: v, model: "m-test" });
    },
    embed(texts) {
      calls.push({ task: "embed", prompt: texts.join("\n") });
      return embedding instanceof Error ? Promise.reject(embedding) : Promise.resolve(texts.map(() => embedding));
    },
  };
  return { ai, calls };
}

export function makeDeps(opts: {
  db?: Partial<Db>;
  messages?: MessageRow[];
  ai?: Ai;
  stale?: boolean;
  cached?: OutputRow | null;
} = {}) {
  const over: Partial<Db> = opts.db ?? {};
  const inserted: NewOutput[] = [];
  const traces: import("../_shared/db.ts").TraceRow[] = [];
  const sfActionLog: import("../_shared/db.ts").NewStorefrontActionLog[] = [];
  const db: Db = {
    logTrace: (row) => {
      traces.push(row);
      return Promise.resolve();
    },
    getWorkspace: () => Promise.resolve(WS),
    getWidgetTokenHash: () => Promise.resolve(null),
    getOperatorIdByTokenHash: (h) => Promise.resolve(h === TOKEN_HASH ? "op-lan" : null),
    isOperatorMember: () => Promise.resolve(true),
    getConversation: () => Promise.resolve(CONV),
    getMessages: () => Promise.resolve(opts.messages ?? [msg("user", "a", 1), msg("operator", "b", 2), msg("user", "c", 3)]),
    saveTranslations: () => Promise.resolve(),
    getProfiles: () => Promise.resolve([]),
    getWorkspaceAllProfiles: () => Promise.resolve([]),
    getOperator: () => Promise.resolve({ display_name: "Lan Nguyen" }),
    findCachedOutput: () => Promise.resolve(opts.cached ?? null),
    insertOutput: (row) => {
      inserted.push(row);
      return Promise.resolve(42);
    },
    getLatestDraft: () => Promise.resolve(null),
    setAiTopic: () => Promise.resolve(),
    matchHelpdesk: () => Promise.resolve([]),
    hybridMatchHelpdesk: () => Promise.resolve([]),
    matchCases: () => Promise.resolve([]),
    getVariants: () => Promise.resolve([]),
    getJiraRows: () => Promise.resolve([]),
    unlinkJira: () => Promise.resolve(false),
    mergeConversationCustomData: () => Promise.resolve(true),
    getStorefrontSeen: () => Promise.resolve([]),
    markStorefrontSeen: () => Promise.resolve(),
    insertStorefrontActionLog: (row) => {
      sfActionLog.push(row);
      return Promise.resolve(sfActionLog.length);
    },
    listUnreportedStorefrontActions: () => Promise.resolve([]),
    markStorefrontActionsReported: () => Promise.resolve(),
    getStorefrontStoreStatus: () => Promise.resolve(null),
    upsertStorefrontStoreStatus: () => Promise.resolve(),
    getRecentShopDomains: () => Promise.resolve([]),
    listStorefrontStoreStatus: () => Promise.resolve([]),
    getDigestState: () => Promise.resolve(null),
    setDigestState: () => Promise.resolve(),
    getDigestFindings: () => Promise.resolve([]),
    addDigestFindings: () => Promise.resolve(),
    getLatestSessionForShop: () => Promise.resolve(null),
    getStorefrontSegmentCandidates: () => Promise.resolve([]),
    getSentiment: () => Promise.resolve(null),
    saveSentiment: () => Promise.resolve(),
    appendSentimentHistory: () => Promise.resolve(),
    getSentimentHistory: () => Promise.resolve([]),
    getOperatorIdByEmail: () => Promise.resolve(null),
    getReviewSend: () => Promise.resolve(null),
    getCsatSend: () => Promise.resolve(null),
    recordCsatSend: () => Promise.resolve({ sent_at: "2026-10-15T03:05:00+00:00" }),
    releaseCsatSend: () => Promise.resolve(),
    saveReviewTemplate: () => Promise.resolve(),
    addStyleSample: () => Promise.resolve(),
    ...over,
  };
  const n8n: N8n = {
    refreshConversation: () => Promise.resolve({ stale: opts.stale ?? false }),
    triggerJiraSync: () => Promise.resolve(true),
    sendSurvey: () => Promise.resolve(true),
    pushStorefrontReport: () => Promise.resolve(true),
  };
  return { deps: { db, n8n, ai: opts.ai ?? fakeAi({}).ai }, inserted, traces, sfActionLog };
}
