import { unansweredCustomerMessages } from "../_shared/context.ts";
import type { CrispClient } from "../_shared/crisp.ts";
import type { Db } from "../_shared/db.ts";
import type { Ai } from "../_shared/gemini.ts";
import { jiraForConversation } from "../_shared/jira.ts";
import type { N8n } from "../_shared/n8n.ts";
import type { Sentiment } from "../_shared/sentiment.ts";
import { FlowTracer, newFlowId, waitUntilBg } from "../_shared/trace.ts";
import type { ConversationRow } from "../_shared/types.ts";
import { resolveSentiment, sentimentFingerprint } from "./analyze.ts";
import { MESSAGE_LIMIT } from "./load.ts";
import { shopFromCustomData } from "./storefront-actions.ts";
import { runSurvey } from "./survey.ts";

/**
 * Mặt native "Support Operation" — Crisp Generic Widget, bản 6 section
 * theo design Ethan duyệt 30/10 (Chatbot · Khách · Trạng thái · Storefront
 * · Jira · Lệnh), chạy thử trên PLUGIN SURVEY trước (Ethan chốt: dùng
 * chính plugin survey làm xe test, không tạo plugin mới). Section
 * Generic Widget mặc định xổ full khi mở conversation — hết cảnh panel
 * iframe bị thu nhỏ phải bấm expand.
 *
 * Giao thức (docs.crisp.chat — Generic Widget + Plugin Widgets Reference):
 * Crisp POST sự kiện về action URL của plugin:
 *   { action: { type: "button"|"data", method: null|"fetch"|"edit" },
 *     widget: { section_id, item_id },
 *     origin: { website_id, session_id },
 *     payload: { data: {...} }, timestamp }
 * - data + method "fetch": server trả { data: { value } } — value là
 *   string|number|boolean hiển thị cạnh nhãn item.
 * - button (hook/submit): server trả 200 {} — Crisp retry 2-3 lần khi lỗi,
 *   nên MỌI lỗi nghiệp vụ đều nuốt vào trace và vẫn trả 200; chỉ chữ ký sai
 *   mới trả 401.
 *
 * Route này chạy TRƯỚC cổng auth nội bộ trong index.ts: sự kiện Crisp
 * không mang x-copilot-secret/widget token, chúng mang chữ ký riêng
 * X-Crisp-Signature (xem verify ở dưới).
 */

export interface NativeDeps {
  db: Db;
  ai: Ai;
  n8n: N8n;
  /** Việc nền sau response (EdgeRuntime.waitUntil ở index.ts); vắng thì dùng waitUntilBg. */
  background?: (task: Promise<unknown>) => void;
  /**
   * Các khoá ký sự kiện widget (env CRISP_PLUGIN_KEY + CRISP_PLUGIN_KEY_SURVEY
   * ở index.ts): plugin Copilot CS và plugin survey (xe test) ký bằng khoá
   * của chính plugin đó — sự kiện hợp lệ nếu khớp BẤT KỲ khoá nào. Rỗng hết
   * = chưa cấu hình, không verify được.
   */
  pluginKeys?: string[];
  /** Client Crisp REST (chỉ cho đường đồng bộ dải cảm xúc đã duyệt + đọc meta). */
  crisp?: CrispClient | null;
  now?: () => number;
}

export interface CrispWidgetEvent {
  actionType: string;
  method: string | null;
  sectionId: string;
  itemId: string;
  websiteId: string;
  sessionId: string;
  data: Record<string, unknown>;
}

/** Nhận diện sự kiện Generic Widget: `action` là OBJECT {type:"button"|"data"} — khác hẳn body panel/nội bộ (action là string). */
export function isNativeEvent(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const a = b.action as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return false;
  if (a.type !== "button" && a.type !== "data") return false;
  const w = b.widget as Record<string, unknown> | null;
  return Boolean(w && typeof w.item_id === "string" && w.item_id);
}

export function parseNativeEvent(body: unknown): CrispWidgetEvent {
  const b = (body ?? {}) as Record<string, unknown>;
  const a = (b.action ?? {}) as Record<string, unknown>;
  const w = (b.widget ?? {}) as Record<string, unknown>;
  const o = (b.origin ?? {}) as Record<string, unknown>;
  const p = (b.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    actionType: str(a.type),
    method: typeof a.method === "string" ? a.method : null,
    sectionId: str(w.section_id),
    itemId: str(w.item_id),
    websiteId: str(o.website_id),
    sessionId: str(o.session_id),
    data: (p.data && typeof p.data === "object" ? p.data : {}) as Record<string, unknown>,
  };
}

// ---------- Chữ ký sự kiện widget ----------
//
// Crisp ký sự kiện plugin bằng HMAC-SHA256 với khoá token của plugin, hai
// header X-Crisp-Signature + X-Crisp-Request-Timestamp. Cách GHÉP chuỗi ký
// theo Web Hooks Reference của Crisp (docs.crisp.chat/references/web-hooks/v1,
// mục Delivery — Generic Widget guide dẫn về cùng thuật toán này):
//   chuỗi ký = `[${timestamp};${body_as_string}]`
// (có cả cặp ngoặc vuông và dấu chấm phẩy; body_as_string là JSON body dạng
// chuỗi — tài liệu ví dụ JSON.stringify() trên Node). Verify thử CẢ body thô
// trên dây lẫn dạng stringify(parse(body)) để khớp bất kể phía Crisp chuẩn
// hoá theo dạng nào. Chính sách verify mềm:
// - Cả hai header đều VẮNG → chấp nhận, ghi trace cờ unsigned (tránh gãy
//   mặt native nếu Crisp không ký loại sự kiện này).
// - Có header → verify thật; sai → 401 (Crisp không retry 401 theo cùng
//   cách retry 5xx, và request giả phải bị chặn).
// - Chưa cấu hình khoá nào (CRISP_PLUGIN_KEY / CRISP_PLUGIN_KEY_SURVEY)
//   → không verify được: chấp nhận + trace cờ signature_unconfigured.

const enc = new TextEncoder();

export async function computeCrispWidgetSignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`[${timestamp};${rawBody}]`));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyCrispWidgetSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;
  const got = signature.trim().toLowerCase();
  if (safeEqualHex(await computeCrispWidgetSignature(secret, timestamp, rawBody), got)) return true;
  // Tài liệu mô tả body_as_string qua JSON.stringify() của body đã parse —
  // thử thêm dạng chuẩn hoá đó phòng khi body trên dây khác dạng Crisp đã ký.
  try {
    const normalized = JSON.stringify(JSON.parse(rawBody));
    if (normalized !== rawBody) {
      return safeEqualHex(await computeCrispWidgetSignature(secret, timestamp, normalized), got);
    }
  } catch { /* body không phải JSON hợp lệ — dạng thô ở trên là đủ */ }
  return false;
}

// ---------- Chẩn đoán chữ ký (chỉ chạy khi verify fail) ----------
//
// Verify theo đúng tài liệu vẫn fail trên request THẬT của Crisp
// (30/10: plugin survey, key Ethan khẳng định đúng mà mọi fetch đều
// 401). Hàm này thử một loạt biến thể ghép chuỗi ký / dạng body /
// đơn vị timestamp / định dạng digest để xác định Crisp thật sự ký
// theo biến thể nào; nhãn biến thể khớp được ghi vào trace ở nhánh
// 401. NÓ KHÔNG NỚI LỎNG VERIFY: khớp biến thể lạ vẫn trả 401 như
// thường — biến thể thắng sẽ được chốt cứng vào verify sau, bằng một
// thay đổi riêng có kiểm chứng.

async function hmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function b64Of(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Trả nhãn mọi biến thể khớp chữ ký đã cho (rỗng = không biến thể nào khớp — khi đó nghi vấn quay về phía khoá). */
export async function diagnoseCrispWidgetSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): Promise<string[]> {
  if (!secret || !timestamp || !signature) return [];
  const got = signature.trim();
  const gotHex = got.toLowerCase();
  const bodies: Array<[string, string]> = [["raw", rawBody]];
  try {
    const parsed = JSON.parse(rawBody);
    const norm = JSON.stringify(parsed);
    if (norm !== rawBody) bodies.push(["json", norm]);
    const sorted = JSON.stringify(sortKeysDeep(parsed));
    if (sorted !== rawBody && sorted !== norm) bodies.push(["sorted", sorted]);
  } catch { /* body không phải JSON: chỉ còn dạng thô */ }
  const stamps: Array<[string, string]> = [["ms", timestamp]];
  if (/^\d{13}$/.test(timestamp)) stamps.push(["sec", timestamp.slice(0, 10)]);
  const matches: string[] = [];
  for (const [bl, body] of bodies) {
    for (const [tl, ts] of stamps) {
      const variants: Array<[string, string]> = [
        [`[${tl};${bl}]`, `[${ts};${body}]`],
        [`${tl};${bl}`, `${ts};${body}`],
        [`${tl}.${bl}`, `${ts}.${body}`],
        [`${tl}+${bl}`, `${ts}${body}`],
      ];
      for (const [label, payload] of variants) {
        const digest = await hmacSha256(secret, payload);
        if (safeEqualHex(hexOf(digest), gotHex)) matches.push(`${label}:hex`);
        if (b64Of(digest) === got) matches.push(`${label}:b64`);
      }
    }
    const digest = await hmacSha256(secret, body);
    if (safeEqualHex(hexOf(digest), gotHex)) matches.push(`${bl}-only:hex`);
  }
  return matches;
}

// ---------- Định dạng giá trị hiển thị (hàm thuần, có test) ----------

/** Nhãn mood rút gọn cho mặt native (chỗ hiển thị hẹp): giữ đúng chữ của bản thiết kế Ethan duyệt — frustrated là "Đang bực", các mood khác trùng MOOD_LABEL ở _shared/sentiment.ts. */
const MOOD_SHORT: Record<string, string> = {
  frustrated: "Đang bực",
  confused: "Đang bối rối",
  neutral: "Trung tính",
  satisfied: "Hài lòng",
  happy: "Rất vui",
};

/** "38/100 · Đang bực · Khẩn: cao" — chỉ gắn mức khẩn khi urgency = high. */
export function formatMoodValue(s: Sentiment): string {
  const base = `${s.score}/100 · ${MOOD_SHORT[s.mood] ?? s.mood}`;
  return s.urgency === "high" ? `${base} · Khẩn: cao` : base;
}

/** "HH:MM" theo giờ Asia/Saigon từ mốc ISO. Rỗng khi mốc không parse được. */
export function hhmmSaigon(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Saigon",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "";
  return hh && mm ? `${hh}:${mm}` : "";
}

// ---------- Fetch từng item (chỉ đọc DB, không gọi AI đồng bộ) ----------

async function sentimentRow(deps: NativeDeps, websiteId: string, sessionId: string) {
  return deps.db.getSentiment(websiteId, sessionId).catch(() => null);
}

/**
 * Sentiment thiếu hoặc lệch dấu vân tay (khách/CS đã nhắn thêm) → kích
 * analyze chạy NỀN đúng như panel iframe làm lúc mở conversation
 * (compute-on-view): fetch vẫn trả ngay bản đang lưu (hoặc "Chưa phân
 * tích"), lần fetch sau đã có bản mới. Dùng lại resolveSentiment — cùng
 * một đường tính, cùng ghi sentiment_history (source "analyze").
 */
async function kickAnalyzeIfStale(deps: NativeDeps, websiteId: string, sessionId: string): Promise<void> {
  try {
    const [row, messages] = await Promise.all([
      sentimentRow(deps, websiteId, sessionId),
      deps.db.getMessages(websiteId, sessionId, MESSAGE_LIMIT).catch(() => []),
    ]);
    const hasCustomerText = messages.some((m) => m.from === "user" && m.type === "text");
    if (!hasCustomerText) return;
    const stale = !row || row.input_fp !== await sentimentFingerprint(messages);
    if (!stale) return;
    const task = resolveSentiment({ db: deps.db, ai: deps.ai, crisp: deps.crisp, syncBand: true }, websiteId, sessionId, messages, false, "analyze")
      .then(() => undefined, () => undefined);
    if (deps.background) deps.background(task);
    else waitUntilBg(task);
  } catch {
    // Kích nền hỏng không được làm gãy fetch.
  }
}

/** Trạng thái bot BẢN GIẢ (stub, Ethan chốt 30/10): chatbot chưa gộp về chung service với copilot nên section Chatbot chỉ hiện trạng thái tĩnh + hook ghi trace, chưa có hành động thật. */
export const BOT_STUB_STATUS = "CS đang xử lý · Chatbot im lặng";

/** "7 giờ" / "25 phút" / "2 ngày" — khoảng cách từ mốc ISO tới hiện tại, cho dòng quét Storefront. Rỗng khi mốc không parse được. */
export function scanAgeText(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.max(0, Math.round((nowMs - t) / 60000));
  if (mins < 60) return `${mins} phút`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} giờ`;
  return `${Math.round(hours / 24)} ngày`;
}

async function fetchItemValue(itemId: string, ev: CrispWidgetEvent, deps: NativeDeps): Promise<string> {
  const { websiteId, sessionId } = ev;
  switch (itemId) {
    case "bot_trang_thai": {
      return BOT_STUB_STATUS;
    }
    case "khach_diem": {
      const row = await sentimentRow(deps, websiteId, sessionId);
      void kickAnalyzeIfStale(deps, websiteId, sessionId);
      return row ? `${row.score}` : "—";
    }
    case "khach_tam_trang": {
      const row = await sentimentRow(deps, websiteId, sessionId);
      // Không await: việc kích analyze tự đọc lại messages/fingerprint.
      void kickAnalyzeIfStale(deps, websiteId, sessionId);
      return row ? formatMoodValue(row) : "Chưa phân tích";
    }
    case "khach_tom_tat": {
      const row = await sentimentRow(deps, websiteId, sessionId);
      return row?.summary ? row.summary : "—";
    }
    case "khach_van_de": {
      const row = await sentimentRow(deps, websiteId, sessionId);
      return row?.issues?.[0]?.summary ? row.issues[0].summary : "—";
    }
    case "khach_tin_cho": {
      const messages = await deps.db.getMessages(websiteId, sessionId, MESSAGE_LIMIT).catch(() => []);
      return `${unansweredCustomerMessages(messages).length} tin`;
    }
    case "tt_csat": {
      const send = await deps.db.getCsatSend(websiteId, sessionId).catch(() => null);
      if (!send) return "Chưa gửi";
      const hhmm = hhmmSaigon(send.sent_at);
      return hhmm ? `Đã gửi ${hhmm}` : "Đã gửi";
    }
    case "tt_review": {
      const send = await deps.db.getReviewSend(websiteId, sessionId).catch(() => null);
      if (!send) return "Chưa xin";
      const hhmm = hhmmSaigon(send.sent_at);
      return hhmm ? `Đã xin ${hhmm}` : "Đã xin";
    }
    case "tt_storefront": {
      // Cùng cổng với `check`: ngoài phạm vi Storefront Watch (cờ
      // workspace tắt), chat không có shopify_domain, hoặc store chưa
      // được SW theo dõi → "Không áp dụng". Số lỗi lấy từ BẢN CHỤP
      // storefront_store_status (job sweep ghi) — cùng nguồn badge của
      // panel. Hậu tố "· N mới" trong bản thiết kế KHÔNG dựng được từ
      // DB (số finding mới cần list_findings trực tiếp + tập đã thấy,
      // fetch native chỉ đọc DB) nên cố ý bỏ — xem docs/native-panel.md.
      const ws = await deps.db.getWorkspace(websiteId).catch(() => null);
      if (!ws?.storefront_watch) return "Không áp dụng";
      const conv: ConversationRow | null = await deps.db.getConversation(websiteId, sessionId).catch(() => null);
      const shop = shopFromCustomData(conv);
      if (!shop) return "Không áp dụng";
      const snap = await deps.db.getStorefrontStoreStatus(websiteId, shop).catch(() => null);
      if (!snap || !snap.watched) return "Không áp dụng";
      if (snap.open_total <= 0) return "Không có lỗi";
      // Bản thiết kế có thêm "· N mới" — số finding MỚI không suy được từ
      // bản chụp DB (cần list_findings trực tiếp), cố ý bỏ như bản v9.
      const age = scanAgeText(snap.fetched_at, (deps.now ?? Date.now)());
      return age ? `${snap.open_total} lỗi · quét ${age} trước` : `${snap.open_total} lỗi`;
    }
    case "tt_jira": {
      const [rows, conv] = await Promise.all([
        deps.db.getJiraRows(websiteId, sessionId).catch(() => []),
        deps.db.getConversation(websiteId, sessionId).catch(() => null),
      ]);
      const items = jiraForConversation(rows, conv?.last_human_operator_at ?? null);
      return items.length ? `${items.length} ticket` : "Không có";
    }
    case "jira_ticket_1":
    case "jira_ticket_2":
    case "jira_ticket_3": {
      // Schema khai sẵn 3 ô ticket (Generic Widget không sinh item động
      // được): ô thứ N hiện "{KEY} · {Status}" của ticket thứ N, kèm
      // "(new update)" khi ticket có cập nhật chưa xem. Thiếu ticket →
      // chuỗi rỗng.
      const idx = Number(itemId.slice(-1)) - 1;
      const [rows, conv] = await Promise.all([
        deps.db.getJiraRows(websiteId, sessionId).catch(() => []),
        deps.db.getConversation(websiteId, sessionId).catch(() => null),
      ]);
      const item = jiraForConversation(rows, conv?.last_human_operator_at ?? null)[idx];
      if (!item) return "";
      const base = `${item.issue_key} · ${item.status ?? "?"}`;
      return item.has_update ? `${base} (new update)` : base;
    }
    default:
      return "";
  }
}

// ---------- Hook CSAT (nút act_csat) ----------

/**
 * Gửi CSAT survey ngay khi CS bấm trên mặt native — dùng lại NGUYÊN đường
 * runSurvey của panel iframe: cùng claim nguyên tử trên csat_survey_sends,
 * cùng cửa sổ chống bấm đúp 30 giây, nút không bao giờ bị khoá quá cửa sổ
 * đó (Ethan chốt 2026-10-26). Operator resolve theo email Crisp gắn qua
 * data binding của item (payload.data.operator_email → operators.email →
 * crisp_user_id) và phải thuộc workspace; không resolve được thì vẫn gửi
 * với operator rỗng (runSurvey tự fallback tên hiển thị) nhưng ghi trace
 * cờ operator_unresolved. Lỗi gửi được ghi trace, KHÔNG trả lỗi cho Crisp
 * (tránh retry làm bắn trùng — claim đã chặn ở tầng DB).
 */
async function runCsatHook(ev: CrispWidgetEvent, deps: NativeDeps, tracer: FlowTracer): Promise<void> {
  const email = typeof ev.data.operator_email === "string" ? ev.data.operator_email.trim() : "";
  let operatorId = "";
  let unresolved = false;
  if (email) {
    const id = await deps.db.getOperatorIdByEmail(email).catch(() => null);
    if (id) {
      const member = await deps.db.isOperatorMember(id, ev.websiteId).catch(() => false);
      if (!member) {
        await tracer.error("csat_hook", "AUTH", `operator ${email} không thuộc workspace`, { item_id: ev.itemId });
        return;
      }
      operatorId = id;
    } else {
      unresolved = true;
    }
  } else {
    unresolved = true;
  }
  const r = await runSurvey(
    { website_id: ev.websiteId, session_id: ev.sessionId, operator_name: "" },
    operatorId,
    { db: deps.db, n8n: deps.n8n },
  );
  if (!r.sent && !r.already) {
    await tracer.error("csat_hook", "UPSTREAM", r.error ?? "gửi survey không thành", { item_id: ev.itemId });
    return;
  }
  await tracer.timing("csat_hook", undefined, {
    item_id: ev.itemId,
    sent: r.sent,
    already: r.already,
    ...(unresolved ? { operator_unresolved: true } : {}),
  });
}

// ---------- Hook Tâm trạng (4 nút theo dải) + stub Chatbot ----------

/** Bốn nút Tâm trạng tĩnh theo dải điểm — schema chỉ hiện đúng một nút nhờ condition đọc custom data `copilot_mood_band`; cả bốn bấm đều = phân tích lại. */
export const MOOD_BUTTON_IDS = new Set(["tam_red", "tam_orange", "tam_black", "tam_green"]);

/** Nút Chatbot bản GIẢ (stub): chưa nối service chatbot thật, hook chỉ ghi trace. */
export const BOT_BUTTON_IDS = new Set(["bot_tra_loi", "bot_chan"]);

/**
 * Bấm nút Tâm trạng = đo lại sentiment NGAY (force) — cùng đường
 * resolveSentiment của panel, gồm cả đồng bộ dải lên custom data để lần
 * mở chat sau hiện đúng nút màu mới. Chạy đồng bộ trong hook: Crisp cho
 * hook vài giây, một lượt đo ~2–4s; lỗi đo được ghi trace, vẫn trả 200.
 */
async function runMoodRecompute(ev: CrispWidgetEvent, deps: NativeDeps, tracer: FlowTracer): Promise<void> {
  const t0 = performance.now();
  const messages = await deps.db.getMessages(ev.websiteId, ev.sessionId, MESSAGE_LIMIT).catch(() => []);
  const r = await resolveSentiment(
    { db: deps.db, ai: deps.ai, crisp: deps.crisp, syncBand: true },
    ev.websiteId,
    ev.sessionId,
    messages,
    true,
    "analyze",
  );
  await tracer.timing("mood_recompute", Math.round(performance.now() - t0), {
    item_id: ev.itemId,
    ok: Boolean(r.sentiment),
    ...(r.sentiment ? { score: r.sentiment.score } : { reason: r.reason ?? "unknown" }),
  });
}

// ---------- Handler chính ----------

export async function handleNativeEvent(
  body: unknown,
  rawBody: string,
  headers: { signature: string | null; timestamp: string | null },
  deps: NativeDeps,
): Promise<{ status: number; body: unknown }> {
  const ev = parseNativeEvent(body);
  const isFetch = ev.actionType === "data" && ev.method === "fetch";
  const tracer = new FlowTracer(deps.db, {
    website_id: ev.websiteId || null,
    session_id: ev.sessionId || null,
    action: isFetch ? "native_fetch" : "native_hook",
    flowId: newFlowId(`native-${ev.itemId || "unknown"}`),
  });

  // Chữ ký: chính sách mềm đã ghi ở đầu file. Hai plugin (Copilot CS +
  // survey) ký bằng hai khoá khác nhau — hợp lệ khi khớp BẤT KỲ khoá nào
  // đã cấu hình.
  const keys = (deps.pluginKeys ?? []).map((k) => k.trim()).filter(Boolean);
  const hasSigHeaders = Boolean(headers.signature || headers.timestamp);
  if (hasSigHeaders) {
    let ok = false;
    for (const k of keys) {
      if (await verifyCrispWidgetSignature(k, headers.timestamp ?? "", rawBody, headers.signature ?? "")) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      // Chẩn đoán biến thể ký (xem diagnoseCrispWidgetSignature): ghi
      // nhãn biến thể khớp theo từng khoá (k1, k2, ... theo thứ tự
      // deps.pluginKeys) vào trace; "none" = không biến thể nào khớp.
      const diag: string[] = [];
      for (let i = 0; i < keys.length; i++) {
        const m = await diagnoseCrispWidgetSignature(keys[i], headers.timestamp ?? "", rawBody, headers.signature ?? "");
        for (const label of m) diag.push(`k${i + 1}:${label}`);
      }
      await tracer.error("signature", "AUTH", "Chữ ký sự kiện widget không hợp lệ", {
        item_id: ev.itemId,
        sig_diag: diag.length ? diag : "none",
        sig_len: (headers.signature ?? "").trim().length,
        ts_len: (headers.timestamp ?? "").trim().length,
      });
      return { status: 401, body: { error: "invalid signature" } };
    }
  }

  const t0 = performance.now();
  try {
    if (isFetch) {
      const value = ev.websiteId && ev.sessionId ? await fetchItemValue(ev.itemId, ev, deps) : "";
      await tracer.timing("fetch", Math.round(performance.now() - t0), {
        item_id: ev.itemId,
        section_id: ev.sectionId,
        ...(!hasSigHeaders ? { unsigned: true } : {}),
        ...(!keys.length ? { signature_unconfigured: true } : {}),
      });
      return { status: 200, body: { data: { value } } };
    }
    if (ev.actionType === "data") {
      // method "edit" hoặc method lạ: item của mình đều editable:false —
      // trả 200 rỗng thay vì lỗi để Crisp khỏi retry.
      return { status: 200, body: { data: { value: "" } } };
    }
    // Sự kiện nút: act_csat (gửi survey) và 4 nút Tâm trạng theo dải
    // (phân tích lại) có hành động phía server; nút Chatbot là STUB (chỉ
    // ghi trace); các nút modal/link còn lại điều hướng phía Crisp,
    // không POST nghiệp vụ.
    if (ev.itemId === "act_csat" && ev.websiteId && ev.sessionId) {
      await runCsatHook(ev, deps, tracer);
    } else if (MOOD_BUTTON_IDS.has(ev.itemId) && ev.websiteId && ev.sessionId) {
      await runMoodRecompute(ev, deps, tracer);
    } else {
      await tracer.timing("button", Math.round(performance.now() - t0), {
        item_id: ev.itemId,
        section_id: ev.sectionId,
        ...(BOT_BUTTON_IDS.has(ev.itemId) ? { stub: true } : {}),
        ...(!hasSigHeaders ? { unsigned: true } : {}),
        ...(!keys.length ? { signature_unconfigured: true } : {}),
      });
    }
    return { status: 200, body: {} };
  } catch (e) {
    // Nuốt lỗi vào trace, vẫn 200: Crisp retry trên lỗi sẽ nhân đôi hành
    // động (đặc biệt nguy hiểm với hook gửi survey — claim DB là lớp chặn
    // cuối, nhưng không dựa vào may rủi).
    await tracer.error(isFetch ? "fetch" : "hook", "UNKNOWN", e instanceof Error ? e.message : String(e), { item_id: ev.itemId });
    return isFetch ? { status: 200, body: { data: { value: "" } } } : { status: 200, body: {} };
  }
}
