# Transcy — phân tích topic từ chatlog thật (2026-10-19)

Nguồn: 384 conversation cập nhật gần nhất (backfill 90 ngày), Gemini 3.5 Flash-Lite gán topic theo 3 tin đầu của khách (bỏ tin bot). Script: `scripts/analyze-topics.mjs`.

## Kết quả chính
- **~60% inbox không phải yêu cầu hỗ trợ**: email marketing, newsletter, thư mời sự kiện, thông báo hệ thống Shopify (hoá đơn phí quảng cáo, collaborator, theme export). Copilot gắn `system_email` và không soạn tin, không học giọng văn từ nhóm này.
- **Hỗ trợ thật ~40%**: translation 16% · billing thật ~5% · store_access 3% · onboarding 3% · language_switcher 3% · currency 2% · language_setup 1% · geolocation 1%.
- **~22% khách không dùng tiếng Anh** (fr, es, nl, ja, zh, no, de) → CS chỉ trả lời tiếng Anh: draft luôn tiếng Anh, tin khách được dịch sang tiếng Anh trước khi đưa vào AI.
- Segment Crisp thưa: chỉ 36/982 conversation map được topic từ segment (`chatbot_paid_*`, `onboarding-chat`). Phần còn lại cần AI phân loại. Segment `enum_*` là gói của khách, dùng làm ngữ cảnh, không phải topic.

## Vấn đề hay gặp theo topic
| Topic | Vấn đề điển hình |
|---|---|
| translation | dịch tự động catalog; chuyển từ app dịch khác; 404 URL dịch ảnh hưởng SEO; export bản dịch |
| billing | thanh toán lỗi; hỏi gói miễn phí |
| store_access | store chấp nhận/từ chối quyền collaborator |
| onboarding | cài app; dev/test store; tư vấn trước khi chuyển app |
| language_switcher | ẩn/tắt nút; nút che nút mua hàng; không nhúng được vào theme |
| currency | widget che nút; định dạng giá; ký hiệu tiền tệ |
| language_setup | slot ngôn ngữ bị kẹt; URL cho quảng cáo theo ngôn ngữ |
| geolocation | auto-detect không chạy; tự chuyển ngôn ngữ ngoài ý muốn |

Danh sách topic áp dụng: `supabase/seed/transcy-topics.json`.

## Cập nhật 2026-10-19: topic theo tình huống CS xử lý thực tế

Phân tích lại 352 hội thoại có CS người thật trả lời trong 90 ngày (`scripts/derive-situations.mjs`), gom theo cách CS xử lý, chỉ giữ nhóm ≥ 10 hội thoại và xuất hiện ≥ 4 tuần; ca lẻ vào `other`.

| Topic | Hội thoại có CS | Tuần |
|---|---|---|
| translation_content — Nội dung dịch | 108 (31%) | 14 |
| switcher_display — Nút chuyển ngôn ngữ | 66 (19%) | 13 |
| billing_and_plan — Thanh toán & gói | 61 (17%) | 14 |
| technical_bugs — Lỗi kỹ thuật, chuyển tech | 43 (12%) | 14 |
| setup_access — Cài đặt & quyền truy cập (gồm gỡ thẻ tc) | 20 (6%) | 12 |
| currency_and_market — Tiền tệ & thị trường | 13 (4%) | 7 |
| system_email — Email hệ thống/marketing | 33 (9%) | — |
| other — Khác | 8 (2%) | — |

Segment Crisp ở Transcy chủ yếu là tên gói (`transcy`, `enum_growth`…), không phản ánh tình huống, nên topic chủ yếu do AI phân loại (1.583 hội thoại đã gán). Bộ này thay cho 10 topic theo tính năng ở trên.
