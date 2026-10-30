# Mặt native "Support Operation" — Crisp Generic Widget (bản 6 section, design 30/10)

Tài liệu vận hành cho mặt native: nó là gì, Ethan cần cấu hình gì trên
Crisp, và những điểm nào CHƯA được kiểm chứng trên Crisp thật.

## Vì sao có mặt này

Panel iframe hiện tại bị Crisp thu nhỏ khi mở conversation (CS phải bấm
expand). Section của Generic Widget thì được Crisp **deploy (xổ) mặc
định** — mặt native thay mặt iframe ở vị trí sidebar, còn mọi UI nặng
(soạn draft, note, hỏi KB, Storefront, Jira) vẫn là widget iframe hiện
tại, mở dạng **modal** từ các nút của mặt native qua deep-link
`?open=<view>`.

## Xe test: plugin survey

Bản 6 section chạy thử trên **plugin survey (CSAT tool)** — Ethan chốt
30/10: dùng chính plugin survey làm xe test, KHÔNG tạo plugin mới,
KHÔNG đụng plugin Copilot CS đang chạy cho team. Ổn rồi mới mapping
sang plugin chính.

## 6 section (theo design Ethan duyệt 30/10)

- **Chatbot** (BẢN GIẢ — stub): data "Trạng thái" hiện chuỗi tĩnh
  "CS đang xử lý · Chatbot im lặng"; hai nút hook (Cho chatbot trả lời
  lại / Chặn chatbot vĩnh viễn) chỉ ghi trace, chưa có hành động thật —
  chờ gộp chatbot + copilot về chung một service mới nối thật.
- **Khách**: data Tâm trạng (chuỗi đầy đủ "38/100 · Đang bực · Khẩn:
  cao", server soạn theo điểm mới nhất mỗi lần nạp) + **4 nút Tâm trạng
  tĩnh theo dải** (đỏ Rất bực / cam Đang bực / đen Bình thường / xanh lá
  Hài lòng) — xem mục cơ chế màu bên dưới — + data Tóm tắt, Vấn đề.
- **Trạng thái**: data CSAT survey · Review; nút hook **Gửi CSAT survey**
  (gửi ngay qua runSurvey như panel) + nút modal **Xin review**.
- **Storefront**: data "Lỗi đang mở" ("3 lỗi · quét 7 giờ trước" từ bản
  chụp sweep) + nút modal lớn **Xử lý lỗi Storefront**.
- **Jira**: 3 ô data ticket khai sẵn ("{KEY} · {Status} (new update)")
  + nút modal **Xem ticket Jira**. Generic Widget không sinh item động
  nên số ô là cố định; chat có hơn 3 ticket thì modal/panel vẫn đủ.
- **Lệnh**: Soạn reply (modal, tím) · Private note (modal, cam — enum
  Crisp không có vàng) · Hỏi KB qua chatbot (modal, xanh dương).

## Cơ chế nút Tâm trạng đổi màu theo dải

Condition của Crisp Generic Widget **chỉ đọc dữ liệu của Crisp**
(`{conversation.meta.data.*}`, trạng thái chat...), KHÔNG đọc giá trị
server trả về khi fetch data item (đọc từ Generic Widget guide chính
thức). Vì vậy dải cảm xúc phải nằm trong **custom data của
conversation**: mỗi lần tính sentiment MỚI, server ghi key
`copilot_mood_band` = red/orange/black/green (theo ngưỡng điểm <25 /
25–49 / 50–74 / ≥75) vào custom data — **ngoại lệ ghi Crisp thứ hai
Ethan duyệt tường minh 30/10** (sau segment storefront-watch), thực
hiện ở `copilot/mood-band.ts` qua client `_shared/crisp.ts`: đọc bản
thật, chỉ PATCH khi dải đổi, PATCH object đã merge giữ mọi key khác.
4 nút trong schema gắn condition
`{conversation.meta.data.copilot_mood_band === '<dải>'}` để chỉ hiện
đúng một nút; bấm nút nào cũng là hook **phân tích lại** (force) — đo
xong dải mới tự đồng bộ lên custom data cho lần mở sau.

## Việc Ethan cần làm trên Crisp + Supabase (một lần, cho xe test)

1. **Supabase secrets**: thêm `CRISP_PLUGIN_KEY_SURVEY` = secret của
   Production Token của **plugin survey** (trang tokens của plugin).
   Server verify sự kiện bằng cả hai khoá (plugin chính + survey).
2. Vào **Crisp Marketplace → plugin survey → Settings**, thêm một
   **Generic Widget**, dán toàn bộ `widget/native-panel.json` vào ô
   schema.
3. Đặt **Action URL** của plugin survey về URL function copilot hiện
   tại: `https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot`
   (server tự nhận diện sự kiện Generic Widget qua trường `action`
   dạng object và rẽ nhánh trước cả hai cổng auth).
4. Mở thử một conversation: 6 section phải xổ sẵn, data item tự nạp,
   nút Tâm trạng hiện đúng một dải (với điều kiện conversation đã có
   sentiment + dải đã được ghi — đo mới một lần bằng nút Phân tích ở
   panel hoặc chờ tin khách mới để precompute chạy).

## Hành vi phía server (đã có test khoá)

- **Data fetch**: chỉ đọc DB — không gọi AI đồng bộ. Sentiment
  thiếu/cũ thì fetch trả bản đang lưu (hoặc "Chưa phân tích") và kích
  analyze chạy nền (compute-on-view như panel), kèm đồng bộ dải.
- **Hook CSAT**: nguyên `runSurvey` — claim nguyên tử, cửa sổ chống
  bấm đúp 30 giây, nút không khoá quá cửa sổ đó. Operator resolve từ
  `payload.data.operator_email` → `operators.email`, phải thuộc
  workspace mới gửi.
- **Hook Tâm trạng**: đo lại force qua `resolveSentiment`, ghi trace
  stage `mood_recompute` kèm điểm mới.
- **Hook Chatbot**: stub — chỉ ghi trace với cờ `stub: true`.
- **Mọi sự kiện** đều ghi `trace_log` (action `native_fetch` /
  `native_hook`, flow_id dạng `native-<item_id>-…`). Lỗi nghiệp vụ
  luôn trả **200** (kèm trace) để Crisp không retry nhân đôi hành
  động; ngoại lệ duy nhất là chữ ký sai → **401**. Chữ ký verify bằng
  công thức doc `[<timestamp>;<body_as_string>]` HMAC-SHA256, thử mọi
  khoá đã cấu hình; header vắng → chấp nhận + cờ `unsigned`; chưa có
  khoá nào → cờ `signature_unconfigured`.

## Các điểm CHƯA kiểm chứng (đọc trước khi tin là xong)

1. **Condition ở cấp ITEM** (4 nút Tâm trạng): doc Crisp nói mọi item
   có condition nhưng ví dụ chính thức chỉ ở cấp section. Đây là điểm
   xe test phải trả lời đầu tiên: nếu Crisp bỏ qua condition cấp item,
   cả 4 nút sẽ hiện cùng lúc — khi đó phương án dự phòng là giữ 1 nút
   tĩnh + data item điểm (mất màu theo dải).
2. **PATCH custom data có merge theo key hay ghi đè cả object**: client
   đã phòng thủ bằng đọc-trước-merge-rồi-ghi-cả-object, nên đúng trong
   cả hai trường hợp; vẫn cần một lần ghi thật để xác nhận field
   `copilot_mood_band` xuất hiện trong custom data của conversation.
3. **Data item Storefront KHÔNG có hậu tố "· N mới"** của bản thiết
   kế: số finding MỚI không suy được từ bản chụp DB.
4. **Trạng thái Review** đọc từ `outputs` kind `review` — chưa có
   writer ghi kind đó, item hiện "Chưa xin" cho tới khi có writer.
5. **Private note là nút MODAL, không phải hook** như board Mapping
   phác: đường điền note bắt buộc chạy qua widget + extension (xác
   nhận 2 lớp ở ô soạn), hook thuần server không chạm được ô soạn.
   Muốn hook thật phải có cơ chế extension nhận lệnh từ server — việc
   riêng, chưa làm.
6. **Modal Storefront/Jira**: deep-link `?open=storefront|jira` hiện
   cuộn tới card tương ứng trong panel (chưa phải màn modal riêng như
   board 5.6/5.7). Màn riêng là bước sau khi mặt native chạy ổn.
7. **Nhãn mood rút gọn** trên data item: "Đang bực" thay cho nhãn đầy
   đủ của panel — theo đúng chữ bản thiết kế (chỗ hiển thị hẹp).
