// Template xin review: GIỌNG theo profile, LINK theo workspace (Ethan chốt
// 2026-10-26). Template đã học của từng CS lưu trong agent_profiles kèm biến
// {{review_link}}; server thay biến bằng link của workspace đang làm việc
// (workspaces.review_link) ngay khi trả về panel — CS chuyển workspace thì
// giữ giọng của mình nhưng link tự đổi theo nơi mới. Chưa học được template
// của CS → template mặc định CÓ GHI NGUỒN là mặc định (không im lặng giả vờ
// đã học — nguyên tắc minh bạch của hệ thống học).
import type { ProfileRow } from "./types.ts";

export const REVIEW_LINK_PLACEHOLDER = "{{review_link}}";

export type ReviewTemplateSource = "profile" | "default";

/** Bản tối ưu gợi ý cho template của CS: text đã thay link theo workspace; reason tiếng Việt chỉ đúng đoạn yếu (cơ chế gợi ý — Ethan chốt 2026-10-26). */
export interface TemplateSuggestion {
  text: string;
  reason: string;
}

export interface ResolvedReviewTemplate {
  text: string;
  source: ReviewTemplateSource;
  /** Chỉ có khi template đến từ profile VÀ profile có gợi ý khác với template gốc. Mẫu mặc định không có gợi ý. */
  suggestion: TemplateSuggestion | null;
}

/** Template mặc định khi CS chưa có mẫu đã học: trung tính, có chỗ cho link của workspace. */
export const DEFAULT_REVIEW_TEMPLATE = [
  "Hi there,",
  "",
  "Thank you for reaching out to us. I hope your issue has been resolved. If you're happy with our app and the support you received, we'd be grateful if you could spend a few seconds leaving a review on the Shopify App Store. Your feedback means a lot to us and helps us keep improving.",
  "",
  "Below is the direct link:",
  REVIEW_LINK_PLACEHOLDER,
  "",
  "Thank you so much!",
].join("\n");

/** Thay biến link bằng link của workspace; chưa cấu hình link thì bỏ cả dòng link lẫn câu dẫn link cho khỏi cụt. */
export function applyReviewLink(template: string, reviewLink: string | null): string {
  const link = (reviewLink ?? "").trim();
  if (link) return template.split(REVIEW_LINK_PLACEHOLDER).join(link);
  return template
    .split("\n")
    .filter((line) => !line.includes(REVIEW_LINK_PLACEHOLDER) && line.trim() !== "Below is the direct link:")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const URL_RE = /https?:\/\/\S+/g;
const MD_LINK_RE = /\[__[^\]]*__\]\(https?:\/\/[^)]+\)/g;

/**
 * Học template xin review từ tin thật của một CS (dùng bởi
 * scripts/learn-profiles.ts): gom các tin xin review (có link + nhắc tới
 * review), chuẩn hoá link thành biến {{review_link}}, lấy cụm lặp lại nhiều
 * nhất. Cần ≥ 2 lần dùng cùng một khuôn mới coi là template — một lần lẻ là
 * tin tình huống, không phải thói quen. Không thấy thì trả null (giữ nguyên
 * template đã có, không xoá).
 */
export function mineReviewTemplate(contents: string[]): string | null {
  const clusters = new Map<string, number>();
  for (const raw of contents) {
    const c = (raw ?? "").trim();
    if (!/review/i.test(c) || !URL_RE.test(c)) continue;
    const normalized = c.replace(MD_LINK_RE, REVIEW_LINK_PLACEHOLDER).replace(URL_RE, REVIEW_LINK_PLACEHOLDER).trim();
    if (!normalized.includes(REVIEW_LINK_PLACEHOLDER)) continue;
    clusters.set(normalized, (clusters.get(normalized) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 1; // phải > 1, tức ít nhất 2 lần
  for (const [text, n] of clusters) {
    if (n > bestCount) { best = text; bestCount = n; }
  }
  return best;
}

/**
 * Chọn template xin review cho CS đang trực: ưu tiên dòng profile khớp topic
 * của conversation, rồi bất kỳ dòng nào của chính CS có template. CS chưa có
 * template của mình thì dùng template profile TỐT NHẤT của team trong cùng
 * workspace (nguồn vẫn ghi "default" cho minh bạch — Ethan chốt 2026-10-27:
 * không để CS rơi về template mẫu trung tính trong khi team đã có mẫu thật).
 * Cả team chưa ai có mẫu đã học mới dùng template mẫu trung tính.
 */
/** Gợi ý lưu trong profile → dạng trả về panel: validate hình dạng, thay link theo workspace, và chỉ giữ khi thật sự khác template gốc (gợi ý trùng gốc thì vô nghĩa). */
function resolveSuggestion(row: ProfileRow, templateText: string, reviewLink: string | null): TemplateSuggestion | null {
  const raw = row.review_template_suggestion;
  if (!raw || typeof raw.text !== "string" || typeof raw.reason !== "string") return null;
  if (!raw.text.trim() || !raw.reason.trim()) return null;
  const text = applyReviewLink(raw.text, reviewLink);
  if (text === templateText) return null;
  return { text, reason: raw.reason.trim() };
}

export function resolveReviewTemplate(
  profiles: ProfileRow[],
  topic: string | null,
  reviewLink: string | null,
  fallbackRows: ProfileRow[] = [],
): ResolvedReviewTemplate {
  const usable = profiles.filter((p) => typeof p.review_template === "string" && p.review_template.trim());
  const row = usable.find((p) => topic !== null && p.topic === topic) ?? usable[0];
  if (row) {
    const text = applyReviewLink(row.review_template as string, reviewLink);
    return { text, source: "profile", suggestion: resolveSuggestion(row, text, reviewLink) };
  }
  // Dự phòng theo team: mẫu của CS học được nhiều nhất trong workspace (cùng
  // thứ tự ưu tiên với pickBestProfileRow: conversations_used giảm dần, rồi
  // learned_at mới nhất). Nguồn ghi "default" vì đây không phải mẫu của
  // chính CS đang trực; gợi ý tối ưu không áp cho mẫu mượn.
  const pool = fallbackRows
    .filter((p) => typeof p.review_template === "string" && p.review_template.trim())
    .sort((a, b) =>
      (b.conversations_used ?? 0) - (a.conversations_used ?? 0) ||
      String(b.learned_at ?? "").localeCompare(String(a.learned_at ?? ""))
    );
  const donor = pool.find((p) => topic !== null && p.topic === topic) ?? pool[0];
  if (donor) {
    return { text: applyReviewLink(donor.review_template as string, reviewLink), source: "default", suggestion: null };
  }
  return { text: applyReviewLink(DEFAULT_REVIEW_TEMPLATE, reviewLink), source: "default", suggestion: null };
}
