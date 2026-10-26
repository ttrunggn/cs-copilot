import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { applyReviewLink, mineReviewTemplate, resolveReviewTemplate } from "../_shared/review.ts";
import type { ProfileRow } from "../_shared/types.ts";

const row = (p: Partial<ProfileRow>): ProfileRow => ({
  crisp_user_id: "op-1", website_id: "ws1", topic: "_all", conversations_used: 10,
  learned_at: null, manual_override: null, ...p,
});
const LINK = "https://apps.shopify.com/app-x#modal-show=WriteReviewModal";

Deno.test("resolveReviewTemplate: có template theo profile → dùng giọng của CS, link thay theo workspace", () => {
  const r = resolveReviewTemplate([row({ review_template: "Mẫu của tôi.\n{{review_link}}" })], "billing", LINK);
  assertEquals(r.source, "profile");
  assertEquals(r.text, `Mẫu của tôi.\n${LINK}`);
});

Deno.test("resolveReviewTemplate: ưu tiên dòng khớp topic của conversation", () => {
  const r = resolveReviewTemplate([
    row({ topic: "_all", review_template: "mẫu chung {{review_link}}" }),
    row({ topic: "billing", review_template: "mẫu billing {{review_link}}" }),
  ], "billing", LINK);
  assertStringIncludes(r.text, "mẫu billing");
});

Deno.test("resolveReviewTemplate: chưa học được → mặc định CÓ link của workspace và ghi nguồn default", () => {
  const r = resolveReviewTemplate([row({ review_template: null })], "billing", LINK);
  assertEquals(r.source, "default");
  assertStringIncludes(r.text, LINK);
});

Deno.test("resolveReviewTemplate: không mượn template của người khác — profile rỗng thì mặc định dù workspace có link", () => {
  const r = resolveReviewTemplate([], null, LINK);
  assertEquals(r.source, "default");
});

Deno.test("mineReviewTemplate: cụm lặp ≥ 2 lần thắng, link chuẩn hoá thành biến; tin lẻ một lần không thành template", () => {
  const ask = (url: string) => `If you're happy, please leave a review.\nBelow is the direct link:\n${url}\nThanks`;
  const tpl = mineReviewTemplate([
    ask("https://apps.shopify.com/app-a#modal-show=ReviewListingModal"),
    ask("https://apps.shopify.com/app-a#modal-show=ReviewListingModal"),
    "Một tin xin review khác hẳn, chỉ gửi một lần: https://apps.shopify.com/app-a",
    "Tin thường không liên quan",
    "Đọc review của khách tại https://example.com/reviews nhé", // có chữ review + link nhưng không phải mẫu xin review của CS này? vẫn tính là ứng viên — cụm chỉ xuất hiện 1 lần nên bị loại bởi ngưỡng lặp
  ]);
  assertEquals(tpl, "If you're happy, please leave a review.\nBelow is the direct link:\n{{review_link}}\nThanks");
  assertEquals(mineReviewTemplate(["chỉ một lần: leave a review https://apps.shopify.com/x"]), null);
  assertEquals(mineReviewTemplate(["không có gì", "cũng không"]), null);
});

Deno.test("mineReviewTemplate: link bọc markdown kiểu Crisp cũng chuẩn hoá được", () => {
  const wrapped = "Please leave a review here: [__https://apps.shopify.com/app-a__](https://apps.shopify.com/app-a) thanks";
  const tpl = mineReviewTemplate([wrapped, wrapped]);
  assertEquals(tpl, "Please leave a review here: {{review_link}} thanks");
});

Deno.test("applyReviewLink: workspace chưa cấu hình link → bỏ dòng link và câu dẫn, không để cụt", () => {
  const out = applyReviewLink("Dòng một.\n\nBelow is the direct link:\n{{review_link}}\n\nCảm ơn!", null);
  assertEquals(out, "Dòng một.\n\nCảm ơn!");
});
