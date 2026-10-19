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
