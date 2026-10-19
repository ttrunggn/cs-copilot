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

const SOURCE_LABEL = { topic: "theo topic", all: "chung", default: "mặc định workspace" };
const MAX_CHARS = 300;

export function toViewModel(check, now) {
  const count = check.unanswered.length;
  return {
    header: check.needs_reply ? `${count} tin khách chưa trả lời` : "Không có tin chờ trả lời",
    stale: check.stale,
    needsReply: check.needs_reply,
    unanswered: check.unanswered.slice(-3).map((t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + "…" : t)),
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

/** Draft từ generate hoặc latest_draft của check → dữ liệu hiển thị. Link cảnh báo chỉ nhận https. */
export function toDraftViewModel(out, now = Date.now()) {
  const text = out.draft ?? out.content ?? "";
  const badge = out.verified !== true
    ? "Chưa đối chiếu helpdesk"
    : out.helpdesk_matches === 0
    ? "Không có bài helpdesk liên quan"
    : "Đã đối chiếu helpdesk";
  return {
    text,
    age: out.created_at ? timeAgo(out.created_at, now) : null,
    todos: (text.match(/\[\[CS:[^\]]*\]\]/g) ?? []).length,
    badge,
    warnings: (out.warnings ?? []).map((w) => ({
      claim: w.claim,
      reason: w.reason,
      url: typeof w.article_url === "string" && HTTPS_URL.test(w.article_url) ? w.article_url : null,
    })),
  };
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
