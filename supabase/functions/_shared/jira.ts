// Logic thuần cho Jira: đọc dữ liệu Jira API, phân vai comment, so thay đổi với mốc đã thấy trước,
// và dựng ngữ cảnh Jira cho widget/handoff/draft. Jira là mirror chỉ-đọc vào panel (quy tắc Ethan
// chốt 2026-10-23): module này KHÔNG soạn bất cứ nội dung nào để đăng vào Crisp.
//
// Done trên Jira ≠ CS đã báo cho khách (Ethan, 2026-10-23): ticket chuyển Done mà CS chưa nhắn
// cho khách sau mốc đó thì card VẪN ở lại panel với nhãn "Chờ báo khách" — card chỉ rời panel
// khi CS đã nhắn khách sau mốc Done (doneReportedToCustomer) hoặc CS tự gỡ liên kết. Vì vậy
// jira-sync KHÔNG tắt link ngay khi ticket Done như trước.
import { neutralize } from "./prompts.ts";

export type CommentRole = "tech" | "cs" | "bot";

export interface JiraComment {
  id: string;
  author: string;
  role: CommentRole;
  body_text: string;
  created_at: string;
}

export interface JiraIssue {
  issue_key: string;
  summary: string | null;
  status: string | null;
  status_category: string | null;
  assignee: string | null;
  updated_at: string | null;
  /** Mốc sync phát hiện lần đổi trạng thái gần nhất (saveIssue ghi; null = chưa từng thấy đổi). */
  status_changed_at?: string | null;
  /** Lần cuối mirror được đồng bộ từ Jira (jira_issues.synced_at, saveIssue ghi mỗi lần áp) — check dùng để quyết có tự sync khi mở panel hay không. */
  synced_at?: string | null;
  /** Trạng thái ngay trước lần đổi gần nhất (saveIssue ghi cùng lúc status_changed_at) — để hiện "từ <cũ> → <mới>". */
  prev_status?: string | null;
  comments: JiraComment[];
}

export interface JiraLink {
  website_id: string;
  session_id: string;
  issue_key: string;
  url: string;
  silent_baseline: boolean;
  last_seen_status: string | null;
  last_seen_comment_at: string | null;
}

const IGNORE_AUTHORS = ["Automation for Jira"];
const RECENT_COMMENTS = 3;

/** Atlassian Document Format → text (giữ xuống dòng, bullet, mention, ảnh). */
export function adfToText(n: unknown): string {
  if (!n) return "";
  if (typeof n === "string") return n;
  const node = n as { type?: string; text?: string; attrs?: Record<string, string>; content?: unknown[] };
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return node.attrs?.text ?? "";
  if (node.type === "media" || node.type === "mediaInline") return `[Ảnh: ${node.attrs?.alt || "không tên"}]`;
  if (node.type === "inlineCard" || node.type === "blockCard") return node.attrs?.url ?? "";
  const inner = (node.content ?? []).map(adfToText).join("");
  if (node.type === "listItem") return "• " + inner;
  return ["paragraph", "heading", "blockquote", "codeBlock", "mediaSingle"].includes(node.type ?? "") ? inner + "\n" : inner;
}

const lower = (s: string) => s.trim().toLowerCase();

export function commentRole(author: string, csNames: string[], ignore: string[] = IGNORE_AUTHORS): CommentRole {
  if (ignore.some((x) => lower(x) === lower(author))) return "bot";
  return csNames.some((x) => x && lower(x) === lower(author)) ? "cs" : "tech";
}

/** "2026-10-19T02:00:00.000+0700" (Jira) → ISO UTC. */
function iso(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return isNaN(t) ? null : new Date(t).toISOString();
}

// deno-lint-ignore no-explicit-any
export function normalizeIssue(raw: any, csNames: string[]): JiraIssue {
  const f = raw?.fields ?? {};
  // deno-lint-ignore no-explicit-any
  const comments: JiraComment[] = (f.comment?.comments ?? []).map((c: any) => {
    const author = c.author?.displayName ?? "?";
    return { id: String(c.id), author, role: commentRole(author, csNames), body_text: adfToText(c.body).trim(), created_at: iso(c.created) ?? "" };
  }).filter((c: JiraComment) => c.created_at)
    // Sort bằng epoch, không so chuỗi — created_at đã qua iso() nên đồng dạng,
    // nhưng giữ đúng một chuẩn so thời gian duy nhất trong file (xem epochMs).
    .sort((a: JiraComment, b: JiraComment) => (epochMs(a.created_at) ?? 0) - (epochMs(b.created_at) ?? 0));
  return {
    issue_key: String(raw?.key ?? ""),
    summary: f.summary ?? null,
    status: f.status?.name ?? null,
    status_category: f.status?.statusCategory?.key ?? null,
    assignee: f.assignee?.displayName ?? null,
    updated_at: iso(f.updated),
    comments,
  };
}

export interface LinkDiff {
  kind: "first" | "silent" | "update" | "none";
  statusChanged: boolean;
  newComments: JiraComment[];
  done: boolean;
  next: { last_seen_status: string | null; last_seen_comment_at: string | null };
}

/**
 * Mốc thời gian → epoch ms để SO SÁNH. Không bao giờ so chuỗi ISO thô: comment
 * Jira được chuẩn hoá bằng toISOString() (đuôi ".000Z") trong khi mốc đọc từ
 * Postgres qua PostgREST có đuôi "+00:00" — so chuỗi thì ".000Z" luôn "lớn
 * hơn" "+00:00" ở cùng một thời điểm, khiến comment mới nhất bị tính là mới
 * mãi mãi (đây là gốc rễ vụ note Jira spam mỗi 5 phút, 2026-10-23). Chuỗi
 * rỗng/không parse được → null; mốc null nghĩa là "chưa thấy gì" (mọi comment
 * đều mới), comment không parse được thì không tính là mới.
 */
function epochMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function isAfter(at: string, sinceMs: number | null): boolean {
  const t = epochMs(at);
  return t !== null && (sinceMs === null || t > sinceMs);
}

/** So ticket hiện tại với mốc đã thấy của một chat (chỉ để panel biết có gì mới). Comment bot không tính là cập nhật. */
export function diffLink(link: JiraLink, issue: JiraIssue): LinkDiff {
  // Mốc comment KHÔNG BAO GIỜ đi lùi: payload lần này có thể thiếu comment mới
  // nhất (comment bị xoá trên Jira, search trả thiếu) — lấy max(mốc cũ, comment
  // cuối của payload) theo epoch, nếu không các comment đã thấy sẽ bị tính là
  // mới lại ở lượt sync sau (badge bật lại vô cớ).
  const payloadLast = issue.comments.at(-1)?.created_at ?? null;
  const lastAt = (epochMs(payloadLast) !== null && (epochMs(link.last_seen_comment_at) === null || epochMs(payloadLast)! > epochMs(link.last_seen_comment_at)!))
    ? payloadLast
    : (link.last_seen_comment_at ?? payloadLast);
  const next = { last_seen_status: issue.status, last_seen_comment_at: lastAt };
  const done = issue.status_category === "done";
  if (link.last_seen_status === null) {
    return { kind: link.silent_baseline ? "silent" : "first", statusChanged: false, newComments: [], done, next };
  }
  const sinceMs = epochMs(link.last_seen_comment_at);
  const newComments = issue.comments.filter((c) => c.role !== "bot" && isAfter(c.created_at, sinceMs));
  const statusChanged = issue.status !== link.last_seen_status;
  return { kind: statusChanged || newComments.length ? "update" : "none", statusChanged, newComments, done, next };
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

export interface ConversationJira {
  issue_key: string;
  url: string;
  summary: string | null;
  status: string | null;
  /** Cờ "cập nhật chưa xem" DUY NHẤT của card: đổi trạng thái HOẶC có comment mới kể từ lần CS trả lời khách gần nhất. */
  has_update: boolean;
  status_changed: boolean;
  /** Trạng thái trước lần đổi gần nhất — chỉ có giá trị khi status_changed, để hiện "từ <cũ> → <mới>". */
  prev_status: string | null;
  /** Ticket đang ở nhóm Done trên Jira. */
  done: boolean;
  /** Mốc cập nhật gần nhất của issue trên Jira (panel hiện "Cập nhật …"). */
  updated_at: string | null;
  /** Done nhưng CS chưa nhắn cho khách sau mốc Done → card ở lại panel với nhãn chờ báo. */
  awaiting_report: boolean;
  new_comments: { author: string; role: CommentRole; body: string; created_at: string }[];
  recent_comments: { author: string; role: CommentRole; body: string; created_at: string }[];
}

// Panel là MIRROR của Jira: comment phải nguyên văn (chỉ gộp khoảng trắng
// cho dễ đọc), KHÔNG cắt cụt — trần 300 ký tự cũ làm mất đúng phần kết luận
// của Dev trong các comment dài (Ethan bắt lỗi live 2026-10-26 trên
// TNT-9210). Bản cắt 300 chỉ còn dùng cho khối ngữ cảnh đưa vào prompt AI
// (jiraPromptBlock), nơi ngân sách token là thật.
const view = (c: JiraComment) => ({ author: c.author, role: c.role, body: c.body_text.replace(/\s+/g, " ").trim(), created_at: c.created_at });

/**
 * Ticket đã Done VÀ coi như đã báo khách — suy ra từ tín hiệu duy nhất đang có:
 * CS người thật đã nhắn cho khách SAU mốc ticket chuyển trạng thái lần gần nhất
 * (issue.status_changed_at, do saveIssue ghi lúc phát hiện đổi). Chỉ áp cho
 * ticket đang Done; thiếu một trong hai mốc (chưa từng thấy lần đổi nào, hoặc
 * chat chưa có tin CS nào) → CHƯA coi là đã báo — thà giữ card lại còn hơn để
 * CS lỡ mất việc báo khách (xem ghi chú đầu file).
 */
export function doneReportedToCustomer(issue: JiraIssue | null, lastHumanAt: string | null): boolean {
  if (!issue || issue.status_category !== "done") return false;
  const doneMs = epochMs(issue.status_changed_at);
  const humanMs = epochMs(lastHumanAt);
  return doneMs !== null && humanMs !== null && humanMs > doneMs;
}

/**
 * Ticket của một chat cho widget/prompt. Hai việc lọc/đánh dấu theo mốc CS trả
 * lời khách gần nhất (lastHumanAt):
 * - Badge cập nhật: đổi trạng thái hoặc comment mới (không tính bot) sau mốc đó
 *   → has_update; CS trả lời sau cập nhật thì mốc tự khớp và badge tự tắt.
 * - Done: ticket Done mà CS đã nhắn khách sau mốc Done thì ẩn hẳn khỏi danh
 *   sách; Done chưa báo thì GIỮ LẠI với awaiting_report = true.
 */
export function jiraForConversation(rows: { link: JiraLink; issue: JiraIssue | null }[], lastHumanAt: string | null): ConversationJira[] {
  // lastHumanAt đến từ DB (đuôi "+00:00"), created_at của comment từ Jira/DB —
  // so bằng epoch như diffLink, không so chuỗi (xem epochMs ở trên).
  const sinceMs = epochMs(lastHumanAt);
  const out: ConversationJira[] = [];
  for (const { link, issue } of rows) {
    const done = issue?.status_category === "done";
    if (done && doneReportedToCustomer(issue, lastHumanAt)) continue; // Done + đã báo khách → rời panel
    const human = (issue?.comments ?? []).filter((c) => c.role !== "bot");
    const fresh = sinceMs !== null ? human.filter((c) => isAfter(c.created_at, sinceMs)) : [];
    const statusChanged = Boolean(sinceMs !== null && issue?.status_changed_at && isAfter(issue.status_changed_at, sinceMs));
    out.push({
      issue_key: link.issue_key,
      url: link.url,
      summary: issue?.summary ?? null,
      status: issue?.status ?? null,
      has_update: statusChanged || fresh.length > 0,
      status_changed: statusChanged,
      prev_status: statusChanged ? (issue?.prev_status ?? null) : null,
      done,
      updated_at: issue?.updated_at ?? null,
      awaiting_report: done,
      new_comments: fresh.map(view),
      recent_comments: human.slice(-RECENT_COMMENTS).map(view),
    });
  }
  return out;
}

/** Module panel bật theo ngữ cảnh (internal connections — Ethan chốt 2026-10-23), server tính trong check. */
export interface EnabledModules {
  jira: boolean;
  storefront: boolean;
}

/**
 * Ngữ cảnh phụ cho cổng Storefront theo domain (xem enabledModules):
 * - storefrontWatchEnabled: cờ workspaces.storefront_watch của workspace —
 *   định danh DUY NHẤT của phạm vi SW. Caller luôn truyền từ workspace đã
 *   đọc ở DB; thiếu/false = workspace nằm ngoài phạm vi SW, đường domain
 *   đóng bất kể các trường còn lại.
 * - shopDomain: shopify_domain trong custom_data của chính conversation này.
 * - snapshotWatched: bản chụp storefront_store_status — TỪ 2026-10-26 KHÔNG
 *   còn tham gia cổng (Ethan chốt: cứ có shopify_domain + cờ workspace là
 *   hiện module, store có bug ở SW là phải hiện; bản chụp sweep từng phủ
 *   quyết nhầm store đang được theo dõi thật). Chỉ còn là dữ kiện phụ cho
 *   badge storefront_status; action nạp SW trực tiếp mới là nơi quyết định
 *   store có được theo dõi hay không (trả not_watched).
 */
export interface StorefrontGateContext {
  storefrontWatchEnabled?: boolean;
  shopDomain?: string | null;
  snapshotWatched?: boolean | null;
}

/**
 * Jira: bật khi chat có ticket liên kết. Storefront Watch có HAI đường bật:
 *
 * (a) Đường ticket (mọi workspace): có ticket thuộc Jira của chính workspace —
 * tiền tố issue_key (phần trước "-") bằng workspaces.jira_project đọc từ DB,
 * không hardcode mã của bất kỳ workspace nào. Đường này cũng là dự phòng cho
 * workspace trong phạm vi SW khi domain không có/không được theo dõi.
 *
 * (b) Đường domain (Ethan duyệt 2026-10-23, nới 2026-10-26 — CHỈ trong
 * phạm vi Storefront Watch): chat có shopify_domain trong custom_data là
 * module hiện, KHÔNG cần ticket Jira liên kết và KHÔNG cần bản chụp sweep
 * xác nhận — store có bug ở SW là phải hiện; action nạp trực tiếp trả
 * not_watched nếu SW thật sự không theo dõi domain đó.
 * Phạm vi SW được định danh TƯỜNG MINH bằng cờ workspaces.storefront_watch
 * (migration 023, gate.storefrontWatchEnabled) — đây là định danh DUY NHẤT.
 * TUYỆT ĐỐI không suy phạm vi từ jira_project: workspace khác (OE) cũng có
 * jira_project riêng (OES). Đính chính của Ethan: domain Shopify tự nó cũng
 * KHÔNG chứng minh được là store của Transcy — workspace khác cũng có
 * domain trong visitor data. Chỉ khi cờ bật (hiện chỉ bật cho workspace
 * của chính Transcy khi deploy) thì shopify_domain mới mở được đường (b).
 *
 * snapshotWatched = false (bản chụp xác nhận SW không theo dõi domain) →
 * đường (b) đóng: không có dữ kiện gì để hiện. Chưa có bản chụp (null) →
 * đường (b) vẫn mở và action storefront nạp trực tiếp sẽ quyết định
 * (not_watched / need_shop / ok) như hành vi trước khi có bản chụp.
 *
 * jira_project chưa set (null/rỗng) → không ticket nào là "của workspace"
 * nên đường (a) đóng; đường (b) không phụ thuộc jira_project mà phụ thuộc
 * cờ storefront_watch.
 */
export function enabledModules(
  items: ConversationJira[],
  jiraProject: string | null | undefined,
  gate?: StorefrontGateContext,
): EnabledModules {
  const project = (jiraProject ?? "").trim().toUpperCase();
  const viaTicket = project !== "" && items.some((j) => j.issue_key.split("-")[0].trim().toUpperCase() === project);
  const domain = (gate?.shopDomain ?? "").trim();
  const viaDomain = gate?.storefrontWatchEnabled === true && domain !== "";
  // Ethan chốt 2026-10-26: workspace ĐÃ cấu hình tích hợp (có Jira project,
  // hoặc bật cờ Storefront Watch — tức workspace Transcy) thì hai module
  // LUÔN hiện trên panel, kể cả khi chat chưa có gì (card hiện trạng thái
  // trống) — panel đủ rộng, CS khỏi đoán là thiếu dữ liệu hay module tắt.
  // Workspace chưa cấu hình thì giữ cổng theo ngữ cảnh như cũ.
  return {
    jira: items.length > 0 || project !== "",
    storefront: gate?.storefrontWatchEnabled === true || viaTicket || viaDomain,
  };
}

/** Ngữ cảnh Jira cho prompt handoff/draft (dữ liệu, đã neutralize). Rỗng nếu chat không có ticket. */
export function jiraPromptBlock(items: ConversationJira[]): string {
  if (!items.length) return "";
  return items.map((j) => {
    const head = `${neutralize(j.issue_key)} (${neutralize(j.status ?? "unknown status")}): ${neutralize(oneLine(j.summary ?? "", 300))}`;
    const cs = j.recent_comments.map((c) => `  - [${c.role}] ${neutralize(c.author)}: ${neutralize(c.body)}`);
    return [head, ...cs].join("\n");
  }).join("\n");
}
