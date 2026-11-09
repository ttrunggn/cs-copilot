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

/**
 * Deep-link từ mặt native (Crisp Generic Widget): nút modal mở widget với
 * ?open=<view> để vào thẳng đúng view (xem widget/native-panel.json). Sáu
 * view hợp lệ; giá trị lạ → null (bỏ qua, panel mở như thường).
 */
export const OPEN_VIEWS = ["draft", "note", "ask", "review", "storefront", "jira"];

export function parseOpenParam(search) {
  const open = new URLSearchParams(search).get("open") ?? "";
  return OPEN_VIEWS.includes(open) ? open : null;
}

/**
 * View deep-link → tên modal thật của widget (modalView ở panels.js chỉ có
 * draft | note | ask | csat | explain). Xin review nằm trong modal csat.
 * storefront/jira không có modal — chúng là card inline trên panel, hàm
 * trả null và app.js cuộn tới card thay vì mở modal.
 */
export function openModalName(open) {
  if (open === "review") return "csat";
  if (open === "draft" || open === "note" || open === "ask") return open;
  return null;
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
    // Đầu panel: tên khách + shopify domain của họ.
    customerName: check.customer_name ?? check.customer_email ?? null,
    shopDomain: check.shopify_domain ?? null,
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

/**
 * Tên account của CS đang đăng nhập, lấy từ chính dữ liệu operator mà SDK Crisp
 * trả về — tên trong draft và trên panel phải theo account này, không theo dòng
 * `operators` trong DB (bản sao có thể cũ hoặc do người khác đăng ký hộ).
 * Dò cùng họ hình dạng với operatorIdFrom, cộng chi tiết kiểu Crisp API
 * (details.first_name/last_name). Không thấy thì "" — server còn DB làm dự phòng.
 */
export function operatorNameFrom(data) {
  const containers = [data?.operator, data?.data?.operator, data, data?.data, data?.details];
  for (const c of containers) {
    if (!c || typeof c !== "object") continue;
    const sources = [c.details && typeof c.details === "object" ? c.details : null, c];
    for (const src of sources) {
      if (!src) continue;
      const direct = src.name ?? src.nickname;
      if (typeof direct === "string" && direct.trim()) return direct.trim();
      const first = typeof src.first_name === "string" ? src.first_name.trim() : "";
      const last = typeof src.last_name === "string" ? src.last_name.trim() : "";
      if (first || last) return [first, last].filter(Boolean).join(" ");
    }
  }
  return "";
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

// ---------- thẻ tiến trình (progress) ----------
// Chỉ 4 action AI có thẻ tiến trình từng bước; survey/jira/storefront dùng
// nhãn bận/module loading riêng nên không có mặt ở đây.
export const PROGRESS_STEPS = {
  generate: ["Đọc hội thoại", "Đối chiếu bài helpdesk", "Soạn theo giọng của bạn", "Kiểm tra lại nội dung"],
  analyze: ["Đọc tin nhắn của khách", "Phân tích tâm trạng"],
  ask: ["Tìm trong tài liệu", "Đọc bài liên quan", "Soạn câu trả lời kèm nguồn"],
  handoff: ["Đọc hội thoại", "Viết private note"],
};
// Mốc thời gian (ms) chuyển sang bước kế — nhịp hiển thị; bước cuối giữ
// nguyên cho tới khi server trả kết quả thật (không tự "hoàn thành" giả).
export const PROGRESS_MARKS = [0, 900, 2200, 4200];

/** Bước tiến trình đang hiện sau `elapsedMs` ms của `action`; action không có thẻ tiến trình → 0. */
export function progressStepIndex(action, elapsedMs) {
  const steps = PROGRESS_STEPS[action] ?? [];
  let idx = 0;
  while (idx < steps.length - 1 && elapsedMs >= (PROGRESS_MARKS[idx + 1] ?? Number.POSITIVE_INFINITY)) idx++;
  return idx;
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

/**
 * Trạng thái note handoff: copilot KHÔNG tự đăng note (quy tắc ghi Crisp).
 * Note được điền vào ô Note của Crisp qua extension;
 * CS tự sửa ngay trong ô Note rồi tự đăng. Không còn trạng thái "đã đăng".
 */
export function handoffStatus(h) {
  return h.cached ? "Note đã tạo trước đó — chưa đăng" : "Note mới — chưa đăng";
}

const INSERT_MESSAGES = {
  inserted: "Đã điền draft vào ô Reply, đọc lại rồi bấm Send",
  session_mismatch: "Draft của chat khác đã sẵn sàng, mở lại đúng chat để điền",
  not_empty: "Ô Reply đang có chữ",
  duplicate: "Draft này đã được điền rồi",
  composer_not_found: "Không tìm thấy ô soạn trong Crisp — tải lại trang Crisp rồi thử lại",
  note_unconfirmed: "Chưa xác nhận được ô Note trong Crisp — chưa điền gì cả. Mở sẵn tab Note trong Crisp rồi thử lại",
  // Extension đã ghi nhưng đọc lại không thấy chữ khớp :
  // không được báo "đã điền" như inserted — nói rõ để CS tự nhìn lại ô soạn.
  insert_unverified: "Đã thử điền nhưng chưa xác nhận được chữ có vào ô Reply — nhìn lại ô Reply trong Crisp, nếu trống thì thử điền lại",
};

const NOTE_INSERT_MESSAGES = {
  inserted: "Đã điền note vào ô Note, sửa lại rồi tự đăng trong Crisp",
  session_mismatch: "Note của chat khác, mở lại đúng chat để điền",
  not_empty: "Ô Note đang có chữ",
  duplicate: "Note này đã được điền rồi",
  insert_unverified: "Đã thử điền nhưng chưa xác nhận được chữ có vào ô Note — nhìn lại ô Note trong Crisp, nếu trống thì thử điền lại",
};

/** Lời nhắn theo kết quả extension trả về; target "note" dùng bộ chữ riêng cho ô Note. */
export function insertResultMessage(status, target = "reply") {
  if (target === "note") return NOTE_INSERT_MESSAGES[status] ?? INSERT_MESSAGES[status] ?? INSERT_MESSAGES.composer_not_found;
  return INSERT_MESSAGES[status] ?? INSERT_MESSAGES.composer_not_found;
}

/**
 * Template xin review mặc định (fallback toàn cục cuối cùng): đường chính là
 * server phân
 * giải template theo profile của CS qua check.review_template (link thay
 * theo workspace) và widget nạp sẵn vào state.reviewText — giá trị này chỉ
 * còn dùng khi check chưa về hoặc workspace chưa cấu hình gì cả.
 */
export const REVIEW_TEMPLATE = "Hi, thank you for reaching out to us. I hope your issue has been resolved. If you are satisfied with my support, I would really appreciate it if you could take a moment to leave a review of your experience. It means a lot to our team. Thank you so much!";

/**
 * "Vấn đề của khách" cho panel gọn. Nguồn đúng là `issues` do lớp phân tích
 * sinh riêng: mỗi issue là một CÂU PHÁT BIỂU VẤN ĐỀ do AI
 * tổng hợp từ toàn cảnh hội thoại, kèm trích ngắn nguyên văn làm bằng chứng
 * (detail). signals KHÔNG được dùng làm issue — chúng là trích nguyên
 * văn (tin cập nhật tiến độ cũng sẽ thành thẻ ISSUE);
 * signals chỉ hiển thị trong thẻ tâm trạng. Sentiment chưa có issues (dòng cũ
 * hoặc AI chưa sinh) thì lùi về topic; không có gì thì rỗng, không bịa.
 */
export function toIssuesViewModel(check, sentiment) {
  const raw = Array.isArray(sentiment?.issues) ? sentiment.issues : [];
  const issues = raw
    .filter((i) => i && typeof i.summary === "string" && i.summary.trim())
    .slice(0, 3)
    .map((i) => ({
      title: i.summary.trim(),
      detail: typeof i.evidence === "string" && i.evidence.trim() ? `Khách nhắn: "${i.evidence.trim()}"` : null,
    }));
  if (issues.length) return { issues };
  // Không có thẻ dự phòng theo chủ đề (thẻ
  // "Khác / Chủ đề của hội thoại" vô nghĩa với CS). Chưa có issue thật thì
  // để trống — khối Vấn đề tự hiện câu chưa-ghi-nhận, phân tích xong nạp lại.
  return { issues: [] };
}

/** Nhãn bug ngắn hardcode theo kind của SW (panel chỉ cần nói ngắn gọn là bug gì). Kind lạ → dùng nguyên tên kind. */
const SF_SHORT_LABELS = {
  "Graphic lost": "Mất hình ảnh",
  "Region missing": "Thiếu vùng nội dung",
  "Layout degraded": "Lệch giao diện",
  "Block collapsed": "Khối nội dung bị sập",
  "Height jump": "Trang giật khi tải",
  "Raw template visible": "Lộ mã template",
  "Option unidentifiable": "Không phân biệt được tuỳ chọn sản phẩm",
  "Structure changed": "Thay đổi cấu trúc",
};

/** 3 trạng thái issue Storefront. */
export const SF_GROUPS = [
  { status: "new", label: "Mới" }, // issue mới được update
  { status: "acknowledged", label: "Đã xác nhận" }, // đã tiếp nhận, sync từ đợt trước
  { status: "in_progress", label: "Đang xử lý" }, // team CS đã contact khách, suy từ hội thoại
];

/**
 * Storefront Watch → view model cho panel, gom issue theo đúng 3 trạng thái.
 * Nguồn thật: action `storefront` của server (MCP Storefront Watch gọi trực
 * tiếp, server tự chia 3 trạng thái bằng watermark storefront_seen + khớp
 * hội thoại). state.storefront do app.js đổ vào:
 * { status: "loading"|"ok"|"error"|"unconfigured"|"need-shop", store,
 *   scannedAt, isStale, notWatched, error,
 *   new: [{title,meta,fingerprint,kind,locale,page,severity,text,consoleLink,pageLink}],
 *   acknowledged: [...], inProgress: [...] }.
 * Trong mỗi nhóm, finding trùng căn nguyên (cùng kind+page, khác locale)
 * được gom thành một mục có entries[] giữ từng finding riêng (groupSameRootCause).
 * null → kind "empty". Dữ liệu thô kiểu cũ (confirmed: [{level,…}]) vẫn đọc
 * được: level "new" → nhóm Mới, còn lại → nhóm Đã xác nhận; mảng unverified
 * cũ bị bỏ (ngoài 3 trạng thái).
 */
/**
 * Gom các finding TRÙNG CĂN NGUYÊN trong cùng một nhóm trạng thái: cùng
 * (kind + page), chỉ khác locale — SW báo mỗi locale một finding riêng nên
 * một lỗi ở 3 ngôn ngữ hiện 3 dòng rời khiến CS phải tự nhận ra chúng là
 * một. Mục đã gom giữ MỌI entry riêng (fingerprint/locale/console link của
 * từng finding) để mở chi tiết và deep-link vẫn đúng từng bug; count của
 * nhóm và totalCount của module LUÔN đếm theo finding thật (trước gom),
 * không lệch vì gom. Finding thiếu kind hoặc page → không đủ căn cứ gom,
 * đứng riêng một mục như cũ. Dữ kiện kiểu cũ (chỉ title/meta) cũng đứng
 * riêng vì không có kind/page.
 */
function groupSameRootCause(items) {
  const groups = [];
  const byKey = new Map();
  for (const d of items) {
    const entry = {
      fingerprint: d.fingerprint ?? null,
      locale: d.locale ?? null,
      meta: d.meta ?? "",
      severity: d.severity ?? null,
      text: d.text ?? null,
      consoleLink: d.consoleLink ?? null,
      pageLink: d.pageLink ?? null,
      issuePageLink: d.issuePageLink ?? null,
      title: d.title ?? "",
    };
    const kind = d.kind ?? null;
    const page = d.page ?? null;
    if (!kind || !page) {
      groups.push({ title: entry.title, meta: entry.meta, kind, page, locales: entry.locale ? [entry.locale] : [], entries: [entry], count: 1 });
      continue;
    }
    const key = `${kind}|${page}`;
    const g = byKey.get(key);
    if (g) {
      g.entries.push(entry);
      if (entry.locale && !g.locales.includes(entry.locale)) g.locales.push(entry.locale);
      g.count = g.entries.length;
    } else {
      const ng = { title: entry.title, meta: entry.meta, kind, page, locales: entry.locale ? [entry.locale] : [], entries: [entry], count: 1 };
      byKey.set(key, ng);
      groups.push(ng);
    }
  }
  return groups;
}

export function toStorefrontViewModel(sf, now = Date.now()) {
  if (!sf) return { kind: "empty" };
  if (sf.status === "loading") return { kind: "loading" };
  if (sf.status === "need-shop") return { kind: "need-shop" };
  if (sf.status === "unconfigured") return { kind: "unconfigured", ...(sf.error ? { message: sf.error } : {}) };
  if (sf.status === "error") return { kind: "error", ...(sf.error ? { message: sf.error } : {}) };
  if (!sf.store) return { kind: "missing-domain" };
  const buckets = { new: [], acknowledged: [], in_progress: [] };
  const push = (status, d) => buckets[status].push({
    title: d?.title ?? "", meta: d?.meta ?? "", fingerprint: d?.fingerprint ?? null,
    kind: d?.kind ?? null, locale: d?.locale ?? null, page: d?.page ?? null,
    severity: d?.severity ?? null, text: d?.text ?? null, consoleLink: d?.consoleLink ?? null, pageLink: d?.pageLink ?? null, issuePageLink: d?.issuePageLink ?? null,
  });
  for (const d of sf.new ?? []) push("new", d);
  for (const d of sf.acknowledged ?? []) push("acknowledged", d);
  for (const d of sf.inProgress ?? sf.in_progress ?? []) push("in_progress", d);
  if (!sf.acknowledged && !sf.new) {
    for (const d of sf.confirmed ?? []) push(d?.level === "new" ? "new" : "acknowledged", d);
  }
  const groups = SF_GROUPS.map((g) => {
    const raw = buckets[g.status];
    return { ...g, items: groupSameRootCause(raw), count: raw.length };
  });
  // Danh sách PHẲNG theo TỪNG finding:
  // hiện đủ mọi bug SW trả về, mỗi bug một dòng + pill trạng thái + 1 link
  // unit sang Console. Thứ tự: theo nhóm trạng thái SF_GROUPS, trong nhóm
  // giữ thứ tự server (nặng nhất trước).
  const rows = groups.flatMap((g) => g.items.flatMap((d) => d.entries.map((e) => ({
    status: g.status,
    pill: g.label,
    shortLabel: SF_SHORT_LABELS[e.kind ?? d.kind ?? d.title] ?? d.title,
    meta: e.meta ?? "",
    consoleLink: e.consoleLink ?? null,
    pageLink: e.pageLink ?? null,
    issuePageLink: e.issuePageLink ?? null,
    fingerprint: e.fingerprint ?? null,
  }))));
  return {
    kind: "results",
    store: sf.store,
    scannedLabel: sf.scannedAt ? timeAgo(sf.scannedAt, now) : null,
    groups,
    rows,
    totalCount: groups.reduce((n, g) => n + g.count, 0),
    isStale: Boolean(sf.isStale),
    ...(sf.notWatched ? { notWatched: true } : {}),
  };
}

/**
 * Mẫu giải thích một finding Storefront để CS điền vào ô Reply (insert-only
 * qua extension như mọi draft — CS đọc/sửa rồi tự bấm Send; copilot không
 * tự gửi). Mẫu TĨNH theo loại lỗi (kind) phía SW, tiếng Anh theo chuẩn trả
 * khách, chèn sẵn trang/ngôn ngữ/đoạn text lỗi của finding để CS khỏi gõ
 * lại. Kind lạ hoặc thiếu dữ kiện → mẫu chung: xác nhận có lỗi hiển thị ở
 * store của khách + team đang xử lý + sẽ cập nhật khi xong. Mẫu không bịa
 * thời gian sửa xong và không nhắc tên công cụ nội bộ.
 */
const EXPLANATION_BY_KIND = {
  "Region missing": (c) => `a section of content is missing ${c.where}${c.version}`,
  "Option unidentifiable": (c) => `some product options can't be told apart ${c.where}${c.version}${c.textBit}`,
  "Graphic lost": (c) => `an image is not loading ${c.where}${c.version}${c.textBit}`,
  "Layout degraded": (c) => `the layout doesn't look right ${c.where}${c.version}`,
  "Block collapsed": (c) => `a content block appears collapsed or empty ${c.where}${c.version}${c.textBit}`,
  "Height jump": (c) => `the page layout visibly jumps while loading ${c.where}${c.version}`,
  "Raw template visible": (c) => `raw template code is showing as text on the page ${c.where}${c.version}${c.textBit}`,
};

export function explanationTemplate(f) {
  const page = typeof f?.page === "string" && f.page.trim() ? f.page.trim() : null;
  const locale = typeof f?.locale === "string" && f.locale.trim() ? f.locale.trim() : null;
  const text = typeof f?.text === "string" && f.text.trim() ? f.text.trim() : null;
  const ctx = {
    where: page ? `on ${page}` : "on your store",
    version: locale ? ` in the ${locale} version of the store` : "",
    textBit: text ? ` (around the part showing "${text}")` : "",
  };
  const kind = typeof f?.kind === "string" && f.kind.trim() ? f.kind.trim() : (typeof f?.title === "string" ? f.title.trim() : "");
  const describe = EXPLANATION_BY_KIND[kind] ?? ((c) => `there is a display issue ${c.where}${c.version}`);
  return `Hi, thank you for letting us know. We've checked on our side and confirmed that ${describe(ctx)}. ` +
    "Our technical team is already aware of this and is working on it. We'll update you as soon as it's fixed — sorry for the inconvenience in the meantime.";
}

/**
 * Module bật theo ngữ cảnh (internal connections): server tính sẵn trong
 * check.modules — Jira theo ticket liên kết; Storefront khi có ticket thuộc
 * Jira của chính workspace, HOẶC (chỉ trong workspace Transcy) khi chat có
 * shopify_domain mà SW đang theo dõi, không cần ticket (xem enabledModules
 * ở _shared/jira.ts phía server) — widget chỉ render module được bật.
 * Response thiếu modules (server cũ / bản check cache từ trước) → fallback an
 * toàn: Jira theo dữ liệu ticket liên kết như hành vi cũ, Storefront ẩn.
 */
export function enabledModules(check) {
  const m = check?.modules;
  if (m) return { jira: Boolean(m.jira), storefront: Boolean(m.storefront) };
  return { jira: (check?.jira ?? []).length > 0, storefront: false };
}

/**
 * Ticket Jira của chat: tiêu đề + MỘT cơ chế dấu hiệu duy nhất từ server —
 * badge "Cập nhật mới" (has_update: đổi trạng thái hoặc comment mới kể từ lần
 * CS trả lời khách gần nhất) và nhãn "Chờ báo khách" (awaiting_report: ticket
 * Done trên Jira nhưng CS chưa nhắn cho khách sau mốc Done — Done ≠ đã báo).
 * Link chỉ nhận https.
 */
export function toJiraViewModel(items, now = Date.now()) {
  return (items ?? []).map((j) => {
    // Comment mới nhất của team Tech (gộp new + recent, khử trùng) — dữ kiện
    // CS cần nhất trên card; các comment còn lại xem thẳng trong Jira.
    const seen = new Set();
    const comments = [];
    for (const c of [...(j.new_comments ?? []), ...(j.recent_comments ?? [])]) {
      const k = `${c.author}|${c.created_at}|${c.body}`;
      if (seen.has(k)) continue;
      seen.add(k);
      comments.push(c);
    }
    comments.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const tech = comments.filter((c) => c.role === "tech").at(-1) ?? null;
    const latestAt = j.updated_at ?? comments.at(-1)?.created_at ?? null;
    return {
      key: j.issue_key,
      url: typeof j.url === "string" && HTTPS_URL.test(j.url) ? j.url : null,
      name: j.summary ?? j.issue_key,
      status: j.status ?? "Chưa đồng bộ",
      done: j.done === true,
      hasUpdate: j.has_update === true,
      awaitingReport: j.awaiting_report === true,
      statusLine: j.status_changed
        ? (j.prev_status && j.status ? `Đổi trạng thái: ${j.prev_status} → ${j.status}` : "Đổi trạng thái")
        : null,
      updatedLabel: latestAt ? `Cập nhật ${timeAgo(latestAt, now)}` : null,
      latestTech: tech ? { author: tech.author, ago: timeAgo(tech.created_at, now), body: tech.body } : null,
    };
  });
}
