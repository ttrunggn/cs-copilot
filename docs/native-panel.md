# Mặt native "Support Operation" — Crisp Generic Widget trên plugin Copilot CS

Tài liệu vận hành cho mặt native: nó là gì, cần cấu hình gì trên
Crisp, và những giả định cần kiểm khi cấu hình.

## Vì sao có mặt này

Panel iframe hiện tại bị Crisp thu nhỏ khi mở conversation (CS phải bấm
expand). Section của Generic Widget thì được Crisp **deploy (xổ) mặc
định** — đó là lý do duy nhất và là lý do chính đáng: mặt native thay
mặt iframe ở vị trí sidebar, còn mọi UI nặng (soạn draft, note, hỏi KB,
Storefront, Jira) vẫn là widget iframe hiện tại, mở dạng **modal** từ
các nút của mặt native qua deep-link `?open=<view>`.

Mặt native gồm 3 section:

- **Khách**: Tâm trạng · Tóm tắt · Vấn đề · Tin đang chờ (data items,
  fetch khi mở conversation).
- **Trạng thái**: CSAT survey · Review · Storefront Watch · Jira (data
  items).
- **Action**: Soạn draft · Private note · Hỏi KB · Xin review ·
  Storefront Watch · Jira (nút modal mở widget iframe) + **Gửi CSAT
  survey** (nút hook — bấm là gửi ngay phía server, đúng hành vi nút
  survey trên panel hiện tại).

## Cấu hình trên Crisp (một lần)

1. Vào **Crisp Marketplace → plugin Copilot CS → Settings** (nơi cấu
   hình plugin), thêm một **Generic Widget** vào plugin.
2. Dán toàn bộ nội dung file `widget/native-panel.json` vào ô schema
   của Generic Widget đó.
3. Đặt **Action URL** của widget về đúng URL function copilot hiện tại:

   `https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot`

   (Cùng một URL mà n8n/panel đang gọi — server tự nhận diện sự kiện
   Generic Widget qua trường `action` dạng object và rẽ nhánh trước cả
   hai cổng auth; không cần function mới, không cần secret mới.)
4. Lưu và mở thử một conversation: 3 section phải xổ sẵn, các data item
   tự nạp sau khi mở.

Không cần đổi gì ở extension, Netlify hay n8n. Widget iframe cũ vẫn
chạy song song (nó là nội dung của các modal).

## Ánh xạ màu nút (enum của Crisp chỉ có 6 màu)

Crisp chỉ cho `color` thuộc: black, blue, green, orange, red, purple.
Ánh xạ từ bản thiết kế (màu tự do trên mock) sang enum:

| Nút | Màu thiết kế | Màu Crisp |
| --- | --- | --- |
| Soạn draft | xanh dương | blue |
| Private note | vàng/cam | orange |
| Hỏi KB | teal | black (teal không có trong enum) |
| Gửi CSAT survey | xanh dương | blue |
| Xin review | tím | purple |
| Storefront Watch | cam | orange |
| Jira | xám/trung tính | black |

Data item không mang màu trong schema này (chỉ nút mới có `color`).

## Hành vi phía server (đã có test khoá)

- **Data fetch**: chỉ đọc DB (conversation_sentiment, messages,
  csat_survey_sends, outputs, jira_links, bản chụp
  storefront_store_status) — không gọi AI đồng bộ. Sentiment thiếu/cũ
  thì fetch vẫn trả bản đang lưu (hoặc "Chưa phân tích") và kích
  analyze chạy nền đúng đường compute-on-view của panel.
- **Hook CSAT**: dùng lại nguyên `runSurvey` — cùng claim nguyên tử,
  cùng cửa sổ chống bấm đúp 30 giây, nút không bị khoá quá cửa sổ đó.
  Operator được resolve từ `payload.data.operator_email` (item gắn
  `{operator.email}` qua data binding) → `operators.email` →
  `crisp_user_id`, và phải thuộc workspace mới gửi.
- **Mọi sự kiện** đều ghi `trace_log` (action `native_fetch` /
  `native_hook`, flow_id dạng `native-<item_id>-…`).
- Lỗi nghiệp vụ luôn trả **200** (kèm trace) để Crisp không retry nhân
  đôi hành động; ngoại lệ duy nhất là chữ ký sai → **401**.

## Giả định và giới hạn

1. **Cách Crisp ghép chuỗi ký HMAC cho sự kiện widget.** Web Hooks
   Reference của Crisp (docs.crisp.chat/references/web-hooks/v1, mục
   Delivery): chuỗi ký là `[<timestamp>;<body_as_string>]` (có ngoặc
   vuông và chấm phẩy), HMAC-SHA256 bằng secret của Production Token
   (env `CRISP_PLUGIN_KEY`); Generic Widget guide dẫn về cùng thuật
   toán này. Verify thử cả body thô lẫn dạng `JSON.stringify` chuẩn
   hoá; test khoá bằng chữ ký tính ĐỘC LẬP theo công thức doc (không
   qua helper). Chính sách mềm: header VẮNG → chấp nhận + trace cờ
   `unsigned: true`; env thiếu key → cờ `signature_unconfigured: true`;
   có mà sai → 401.
3. **Data item KHÔNG có hậu tố "· N mới" cho Storefront.** Số finding MỚI chỉ tính được từ
   list_findings trực tiếp + tập fingerprint đã thấy; fetch native chủ
   đích chỉ đọc DB nên item hiện `{tổng} lỗi` / `Không có lỗi` /
   `Không áp dụng` từ bản chụp sweep (cùng nguồn badge của panel).
4. **Trạng thái Review** đọc từ `outputs` kind `review` — hiện CHƯA có
   đường nào ghi kind đó (xin review là insert-only qua extension, CS
   tự gửi), nên item sẽ hiện "Chưa xin" cho tới khi có writer ghi nhận.
   Reader đã sẵn (`Db.getReviewSend`); thiếu writer là việc riêng.
5. **Nhãn mood rút gọn**: "Đang bực" thay cho nhãn đầy đủ "Đang bực /
   chưa hài lòng" của panel vì chỗ hiển thị native hẹp.
6. Modal của Generic Widget nhận `website_id`/`token`/`session_id` qua
   query params do Crisp gắn (theo tài liệu) — widget hiện tại đọc ngữ
   cảnh từ đúng các param này (`readContext`), nhưng hành vi thật của
   modal trong workspace Transcy cần một lần mở thử để xác nhận, đặc
   biệt là việc SDK Crisp trong iframe modal có acquire được operator
   hay không (nút điền vào ô soạn vẫn cần extension như thường lệ).
