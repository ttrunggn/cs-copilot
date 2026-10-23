// Logic thuần của widget: không chạm DOM, không chạm mạng.
const SESSION_ID = /^session_[\w-]+$/;
const WEBSITE_ID = /^[\w-]+$/;
const CRISP_TOKEN = /^[\w-]{16,128}$/;
const OPEN_CONVERSATION = "Mở một conversation để dùng copilot";

/** Crisp gắn website_id, session_id và token của website vào URL iframe của widget. */
export function readContext(search) {
  const q = new URLSearchParams(search);
  const websiteId = q.get("website_id") ?? "";
  const sessionId = q.get("session_id") ?? "";
  const crispToken = q.get("token") ?? "";
  if (!CRISP_TOKEN.test(crispToken)) return { error: "Mở copilot từ sidebar của Crisp" };
  if (!WEBSITE_ID.test(websiteId) || !SESSION_ID.test(sessionId)) return { error: OPEN_CONVERSATION };
  return { websiteId, sessionId, crispToken };
}

export function mapError(status, body) {
  const msg = body?.error;
  if (status === 401) return { kind: "fatal", message: msg ?? "Widget không hợp lệ cho workspace này" };
  if (status === 403) return { kind: "forbidden", message: msg ?? "Bạn chưa được cấp quyền ở workspace này" };
  if (status === 404) return { kind: "retry", message: "Chưa có dữ liệu conversation này, thử lại sau vài giây" };
  if (status === 503 && body?.code === "AI_BAD_OUTPUT") return { kind: "retry", message: body.error ?? "AI trả kết quả không dùng được, bấm lại thử" };
  if (status === 503 && body?.code === "AI_UNAVAILABLE") return { kind: "retry", message: "AI đang hết quota hoặc lỗi, thử lại sau" };
  return { kind: "fatal", message: "Không kết nối được copilot, thử lại sau" };
}

export function timeAgo(iso, now) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

const SOURCE_LABEL = { topic: "theo topic", all: "chung", best: "tốt nhất của team", default: "mặc định workspace" };
const MAX_CHARS = 300;

/** Crisp lưu file thành marker + MIME + URL trong content; chỉ mở ảnh từ storage của Crisp. */
function customerMessage(text, botReplied) {
  const raw = String(text ?? "");
  const file = raw.match(/^\s*\[file\]\s*([^\s]+)\s+(https:\/\/[^\s]+)\s*$/i);
  if (!file) return { text: raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) + "…" : raw, botReplied };

  const mime = file[1].toLowerCase();
  let imageUrl = null;
  if (mime.startsWith("image/")) {
    try {
      const url = new URL(file[2]);
      if (url.hostname === "storage.crisp.chat") imageUrl = url.href;
    } catch { /* malformed attachment URL */ }
  }
  return {
    text: imageUrl ? "Khách gửi ảnh" : mime.startsWith("image/") ? "Khách gửi ảnh (không mở được liên kết)" : "Khách gửi tệp đính kèm",
    imageUrl,
    botReplied,
  };
}

export function toViewModel(check, now) {
  const count = check.unanswered.length;
  const pendingMessages = check.pending_messages ?? check.unanswered.map((text) => ({ text, bot_replied: false }));
  const visibleMessages = pendingMessages.slice(-3).map((m) => customerMessage(m.text, Boolean(m.bot_replied)));
  return {
    header: check.needs_reply ? `${count} tin khách đang chờ` : "Không có tin chờ",
    subtitle: check.needs_reply
      ? `Khách nhắn ${timeAgo(check.last_customer_at, now)}${check.bot_replied_count ? ` · Bot đã phản hồi ${check.bot_replied_count} tin, CS chưa trả lời` : " · Chưa có CS trả lời"}`
      : `Khách nhắn ${timeAgo(check.last_customer_at, now)} · CS trả lời ${timeAgo(check.last_human_operator_at, now)}`,
    stale: check.stale,
    needsReply: check.needs_reply,
    unanswered: visibleMessages.map((m) => m.text),
    pendingMessages: visibleMessages,
    pendingCount: count,
    hiddenPendingCount: Math.max(0, count - visibleMessages.length),
    botRepliedCount: check.bot_replied_count ?? visibleMessages.filter((m) => m.botReplied).length,
    topicLabel: check.topic_label ?? check.topic ?? null,
    conversationState: check.conversation_state ?? null,
    metaRows: [
      { label: "Topic", value: check.topic_label ?? check.topic ?? "Chưa xác định" },
      { label: "Giọng văn", value: `${check.profile_name} (${SOURCE_LABEL[check.profile_source] ?? check.profile_source})` },
      { label: "CS trả lời", value: timeAgo(check.last_human_operator_at, now) },
    ],
    meta: [
      `Topic: ${check.topic_label ?? check.topic ?? "chưa xác định"}`,
      `Giọng văn: ${check.profile_name} (${SOURCE_LABEL[check.profile_source] ?? check.profile_source})`,
      `Khách nhắn: ${timeAgo(check.last_customer_at, now)} · CS trả lời: ${timeAgo(check.last_human_operator_at, now)}`,
    ],
  };
}

/** user_id của CS đang đăng nhập, chấp nhận các cấu trúc mà $crisp.data.operator có thể trả về. */
export function operatorIdFrom(data) {
  const id = data?.user_id ?? data?.operator?.user_id ?? data?.data?.operator?.user_id ?? data?.data?.user_id ?? data?.details?.user_id;
  return typeof id === "string" ? id : "";
}

/** Liệt kê tên trường (không lộ giá trị) để chẩn đoán cấu trúc dữ liệu Crisp trả về. */
export function describeShape(data) {
  if (!data || typeof data !== "object") return "(trống)";
  return Object.entries(data)
    .map(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? `${k}{${Object.keys(v).join(",")}}` : k))
    .join(", ");
}

const HTTPS_URL = /^https:\/\//;

/**
 * Trạng thái nút của một action API theo state.busyAction ("" = đang rảnh):
 * nút của chính action đang chạy thì `running` (hiện spinner + nhãn bận);
 * có bất kỳ action nào chạy thì mọi nút action đều `disabled` — giữ nguyên
 * nguyên tắc không gọi API song song như trước, chỉ khác ở phản hồi trực quan.
 */
/** Tin khách dài (nhiều ký tự hoặc nhiều dòng) thì thẻ gợi ý thu gọn 3 dòng + nút Xem thêm. */
export function previewNeedsToggle(text) {
  const t = String(text ?? "");
  return t.length > 160 || t.split("\n").length > 3;
}

export function actionButtonState(busyAction, action) {
  return { running: busyAction === action, disabled: busyAction !== "" };
}

/** Số chỗ [[CS: …]] CS phải tự điền trong draft. */
export function countPlaceholders(text) {
  return (String(text ?? "").match(/\[\[CS:[^\]]*\]\]/g) ?? []).length;
}

/** Draft từ generate hoặc latest_draft của check → dữ liệu hiển thị. Link cảnh báo chỉ nhận https. */
export function toDraftViewModel(out, now = Date.now()) {
  const text = out.draft ?? out.content ?? "";
  // Badge chỉ đếm ý có nguồn thật: ưu tiên mảng sources backend trả về (bài đã đưa vào prompt),
  // bản cache/latest_draft không có sources thì dùng helpdesk_matches đã lưu.
  const sources = (Array.isArray(out.sources) ? out.sources : [])
    .filter((s) => s && typeof s.title === "string" && typeof s.url === "string" && HTTPS_URL.test(s.url))
    .map((s) => ({ title: s.title, url: s.url }));
  const sourcedCount = sources.length || out.helpdesk_matches || 0;
  const badge = out.verified !== true
    ? "Chưa đối chiếu helpdesk"
    : sourcedCount === 0
    ? "Không có bài helpdesk liên quan"
    : `✓ ${sourcedCount} ý có nguồn helpdesk`;
  return {
    text,
    age: out.created_at ? timeAgo(out.created_at, now) : null,
    todos: countPlaceholders(text),
    badge,
    verified: out.verified === true,
    sources,
    warnings: (out.warnings ?? []).map((w) => ({
      claim: w.claim,
      reason: w.reason,
      url: typeof w.article_url === "string" && HTTPS_URL.test(w.article_url) ? w.article_url : null,
    })),
  };
}

/** Kết quả ask (Hỏi tài liệu) → dữ liệu hiển thị. Link nguồn chỉ nhận https, như draft. */
export function toAskViewModel(out) {
  const sources = (Array.isArray(out?.sources) ? out.sources : [])
    .filter((s) => s && typeof s.title === "string" && typeof s.url === "string" && HTTPS_URL.test(s.url))
    .map((s) => ({ title: s.title, url: s.url }));
  const answer = typeof out?.answer === "string" ? out.answer.trim() : "";
  return { found: out?.found === true && answer !== "", answer, sources };
}

/** Đáp án tài liệu → ý của CS cho generate ("Soạn thành tin trả lời khách"). Cắt đúng trần hint phía server (500 ký tự) để panel hiện gì thì AI nhận nấy. */
export function askAnswerToHint(answer) {
  return String(answer ?? "").trim().slice(0, 500);
}

/** Trạng thái note handoff: chỉ báo "đã đăng trước đó" khi note thật sự đã lên Crisp. */
export function handoffStatus(h) {
  if (!h.posted) return "Chưa đăng được note, copy giúp";
  return h.cached ? "Note này đã đăng trước đó" : "Đã đăng private note";
}

const INSERT_MESSAGES = {
  inserted: "Đã điền draft vào ô Reply, đọc lại rồi bấm Send",
  session_mismatch: "Draft của chat khác đã sẵn sàng, mở lại đúng chat để điền",
  not_empty: "Ô Reply đang có chữ",
  duplicate: "Draft này đã được điền rồi",
  composer_not_found: "Không tìm thấy ô Reply, bấm Copy rồi dán bằng Ctrl+V",
};

export function insertResultMessage(status) {
  return INSERT_MESSAGES[status] ?? INSERT_MESSAGES.composer_not_found;
}

const SF_LEVELS = {
  critical: { label: "Nghiêm trọng", cls: "critical" },
  confirmed: { label: "Đã xác nhận", cls: "confirmed" },
  new: { label: "Mới", cls: "new" },
};

/**
 * Storefront Watch → view model cho panel (board 7) và strip ở board 1.
 * Chưa có nguồn dữ liệu: state.storefront = null → kind "empty" (panel hiện trạng thái
 * chưa có dữ liệu, strip không hiện). Khi nối nguồn thật chỉ cần đổ dữ liệu thô vào state:
 * { status: "loading"|"ok"|"error", store, scannedAt, confirmed: [{level,title,meta}],
 *   unverified: [{title,meta}], isStale }.
 */
export function toStorefrontViewModel(sf, now = Date.now()) {
  if (!sf) return { kind: "empty" };
  if (sf.status === "loading") return { kind: "loading" };
  if (sf.status === "error") return { kind: "error" };
  if (!sf.store) return { kind: "missing-domain" };
  const confirmed = (sf.confirmed ?? []).map((d) => {
    const lv = SF_LEVELS[d.level] ?? SF_LEVELS.confirmed;
    return { chip: lv.label, chipClass: lv.cls, title: d.title ?? "", meta: d.meta ?? "" };
  });
  const unverified = (sf.unverified ?? []).map((d) => ({ title: d.title ?? "", meta: d.meta ?? "" }));
  return {
    kind: "results",
    store: sf.store,
    scannedLabel: sf.scannedAt ? timeAgo(sf.scannedAt, now) : null,
    confirmed,
    confirmedCount: confirmed.length,
    unverified,
    unverifiedCount: unverified.length,
    isStale: Boolean(sf.isStale),
  };
}

/** Ticket Jira của chat: tiêu đề + badge MỚI + các tin mới kể từ lần CS trả lời gần nhất. Link chỉ nhận https. */
export function toJiraViewModel(items, now = Date.now()) {
  return (items ?? []).map((j) => ({
    key: j.issue_key,
    url: typeof j.url === "string" && HTTPS_URL.test(j.url) ? j.url : null,
    title: `${j.issue_key} · ${j.status ?? "chưa đồng bộ"}`,
    summary: j.summary,
    isNew: j.is_new,
    news: [
      ...(j.status_changed ? ["Đổi trạng thái"] : []),
      ...j.new_comments.slice(-2).map((c) => `${c.role === "tech" ? "Tech" : c.role === "cs" ? "CS" : "Bot"} · ${c.author} (${timeAgo(c.created_at, now)}): ${c.body}`),
    ],
  }));
}
