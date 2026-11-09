import { unansweredCustomerMessages } from "../_shared/context.ts";
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
 * Mặt native "Support Operation" — Crisp Generic Widget trên CÙNG plugin
 * Copilot CS (cần mặt native vì section Generic Widget
 * mặc định xổ full khi mở conversation, hết cảnh panel iframe bị thu nhỏ).
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
  /** Khoá ký sự kiện widget của plugin (env CRISP_PLUGIN_KEY ở index.ts). Rỗng = chưa cấu hình, không verify được. */
  pluginKey?: string;
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
// - Env chưa có CRISP_PLUGIN_KEY → không verify được: chấp nhận + trace
//   cờ signature_unconfigured để còn biết mà cấu hình.

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

// ---------- Định dạng giá trị hiển thị (hàm thuần, có test) ----------

/** Nhãn mood rút gọn cho mặt native (chỗ hiển thị hẹp): giữ đúng chữ của bản thiết kế — frustrated là "Đang bực", các mood khác trùng MOOD_LABEL ở _shared/sentiment.ts. */
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
    const task = resolveSentiment({ db: deps.db, ai: deps.ai }, websiteId, sessionId, messages, false, "analyze")
      .then(() => undefined, () => undefined);
    if (deps.background) deps.background(task);
    else waitUntilBg(task);
  } catch {
    // Kích nền hỏng không được làm gãy fetch.
  }
}

async function fetchItemValue(itemId: string, ev: CrispWidgetEvent, deps: NativeDeps): Promise<string> {
  const { websiteId, sessionId } = ev;
  switch (itemId) {
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
      return snap.open_total > 0 ? `${snap.open_total} lỗi` : "Không có lỗi";
    }
    case "tt_jira": {
      const [rows, conv] = await Promise.all([
        deps.db.getJiraRows(websiteId, sessionId).catch(() => []),
        deps.db.getConversation(websiteId, sessionId).catch(() => null),
      ]);
      const items = jiraForConversation(rows, conv?.last_human_operator_at ?? null);
      return items.length ? `${items.length} ticket` : "Không có";
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
 * đó. Operator resolve theo email Crisp gắn qua
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

  // Chữ ký: chính sách mềm đã ghi ở đầu file.
  const key = deps.pluginKey ?? "";
  const hasSigHeaders = Boolean(headers.signature || headers.timestamp);
  if (hasSigHeaders) {
    const ok = key
      ? await verifyCrispWidgetSignature(key, headers.timestamp ?? "", rawBody, headers.signature ?? "")
      : false;
    if (!ok) {
      await tracer.error("signature", "AUTH", "Chữ ký sự kiện widget không hợp lệ", { item_id: ev.itemId });
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
        ...(!key ? { signature_unconfigured: true } : {}),
      });
      return { status: 200, body: { data: { value } } };
    }
    if (ev.actionType === "data") {
      // method "edit" hoặc method lạ: item của mình đều editable:false —
      // trả 200 rỗng thay vì lỗi để Crisp khỏi retry.
      return { status: 200, body: { data: { value: "" } } };
    }
    // Sự kiện nút: chỉ act_csat (hook) có hành động phía server; các nút
    // modal/link còn lại điều hướng phía Crisp, không POST nghiệp vụ.
    if (ev.itemId === "act_csat" && ev.websiteId && ev.sessionId) {
      await runCsatHook(ev, deps, tracer);
    } else {
      await tracer.timing("button", Math.round(performance.now() - t0), {
        item_id: ev.itemId,
        section_id: ev.sectionId,
        ...(!hasSigHeaders ? { unsigned: true } : {}),
        ...(!key ? { signature_unconfigured: true } : {}),
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
