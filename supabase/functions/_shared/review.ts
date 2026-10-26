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

export interface ResolvedReviewTemplate {
  text: string;
  source: ReviewTemplateSource;
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
 * của conversation, rồi bất kỳ dòng nào của chính CS có template; không có
 * thì mặc định. Chỉ đọc profile của CHÍNH CS — không mượn template người khác.
 */
export function resolveReviewTemplate(
  profiles: ProfileRow[],
  topic: string | null,
  reviewLink: string | null,
): ResolvedReviewTemplate {
  const usable = profiles.filter((p) => typeof p.review_template === "string" && p.review_template.trim());
  const row = usable.find((p) => topic !== null && p.topic === topic) ?? usable[0];
  if (row) return { text: applyReviewLink(row.review_template as string, reviewLink), source: "profile" };
  return { text: applyReviewLink(DEFAULT_REVIEW_TEMPLATE, reviewLink), source: "default" };
}
