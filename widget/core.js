// Logic thuần của widget: không chạm DOM, không chạm mạng.
const SESSION_ID = /^session_[\w-]+$/;
const WEBSITE_ID = /^[\w-]+$/;
const OPEN_CONVERSATION = "Mở một conversation để dùng copilot";

export function readContext(search) {
  const q = new URLSearchParams(search);
  const websiteId = q.get("website_id") ?? "";
  const sessionId = q.get("session_id") ?? "";
  if (!WEBSITE_ID.test(websiteId) || !SESSION_ID.test(sessionId)) return { error: OPEN_CONVERSATION };
  return { websiteId, sessionId };
}

export function mapError(status, body) {
  const msg = body?.error;
  if (status === 401) return { kind: "needToken", message: msg ?? "Nhập token copilot của bạn" };
  if (status === 403) return { kind: "forbidden", message: msg ?? "Bạn chưa được cấp quyền ở workspace này" };
  if (status === 404) return { kind: "retry", message: "Chưa có dữ liệu conversation này, thử lại sau vài giây" };
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
