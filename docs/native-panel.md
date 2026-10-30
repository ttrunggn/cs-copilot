# Mặt native "Support Operation" — Crisp Generic Widget (panel GỘP dạng mỏng, chốt lại 30/10)

Tài liệu vận hành cho mặt native: nó là gì, Ethan cần cấu hình gì trên
Crisp, và những điểm nào CHƯA được kiểm chứng trên Crisp thật.

## Vì sao có mặt này

Panel iframe hiện tại bị Crisp thu nhỏ khi mở conversation (CS phải bấm
expand). Section của Generic Widget thì được Crisp **deploy (xổ) mặc
định** — mặt native thay mặt iframe ở vị trí sidebar, còn mọi UI nặng
(soạn draft, note, hỏi KB, Storefront, Jira) vẫn là widget iframe hiện
tại, mở dạng **modal** từ các nút của mặt native qua deep-link
`?open=<view>`.

## Xe test: plugin survey + function `copilot-test`

Bản native mỏng chạy thử trên **plugin survey (CSAT tool)** — Ethan chốt
30/10: dùng chính plugin survey làm xe test, KHÔNG tạo plugin mới,
KHÔNG đụng plugin Copilot CS đang chạy cho team.

Vì repo + DB chỉ có một, merge lên master là deploy đè lên function
`copilot` production ngay — nên phần server cũng đi đường test riêng
(Ethan chốt 30/10): deploy code của branch này thành **một Edge
Function riêng tên `copilot-test`** trong cùng project, plugin survey
trỏ Action URL vào đó. Function `copilot` production không đổi một
dòng nào trong suốt quá trình test. Test ổn trên Crisp thật mới merge
PR này để đưa vào production, rồi gỡ `copilot-test`.

Cách deploy function test (máy của Ethan, tại checkout repo): copy
tạm thư mục function rồi deploy dưới tên mới, xong xoá bản copy (KHÔNG
commit thư mục `copilot-test` — test deploy-workflow khoá mọi function
có index.ts phải có trong workflow deploy):

```
git checkout -- extension/dist
git fetch origin
git checkout feat/native-panel-6-sections
git pull
Copy-Item -Recurse supabase/functions/copilot supabase/functions/copilot-test
npx supabase functions deploy copilot-test --no-verify-jwt --use-api --project-ref rbodkthyuiyfotewgxku
Remove-Item -Recurse -Force supabase/functions/copilot-test
```

## 6 section — panel GỘP dạng mỏng (Ethan chốt 30/10: đích là GỘP 2 panel Transcy Bot + Copilot CS thành 1 — mỏng ở cách trình bày, KHÔNG cắt module; mỗi module một section gọn, dữ kiện đi CẶP với nút của nó để nhìn một chỗ là biết trạng thái)

Bản 6 section đầu bị loại sau test live 30/10: Crisp render data item
chỉ hiện value (không nhãn, không bold/màu), không ép section luôn xổ,
sidebar không cuộn nổi khi widget xếp chồng — mặt native chỉ còn vai
**liếc nhanh + mở modal**, mọi nội dung nặng nằm ở modal.

- **Chatbot** (BẢN GIẢ — stub): data trạng thái ("Chatbot: CS đang xử
  lý · Chatbot im lặng") + 2 nút hook (Cho chatbot trả lời lại / Chặn
  chatbot vĩnh viễn) chỉ ghi trace — chờ gộp chatbot + copilot về chung
  một service mới nối thật. Section này GIỮ NGUYÊN trên mặt gộp: đích
  của panel gộp là thay cả card Transcy Bot riêng, không phải né nó.
- **Khách**: data Tâm trạng — value đã nhúng nhãn ("Tâm trạng: 38/100 ·
  Đang bực · Khẩn: cao") vì Crisp không render label của data item.
  Chỉ HIỆN, không có nút bấm phân tích lại: điểm tự cập nhật qua các
  lượt đo nền (Ethan bỏ nút Tâm trạng 30/10 16:26). + data Tóm tắt,
  Vấn đề (value nhúng nhãn "Tóm tắt: …" / "Vấn đề: …").
- **Trạng thái**: data "CSAT: …" + nút hook **Gửi CSAT survey** (gửi
  ngay qua runSurvey như panel) đi cặp; data "Review: …" + nút modal
  **Xin review** đi cặp.
- **Storefront**: data một dòng "Storefront: N lỗi · quét … trước" (số
  lỗi từ bản chụp sweep) ngay trên nút modal **Xử lý lỗi Storefront** —
  nhìn một chỗ biết có lỗi hay không (Ethan bắt 30/10: nút đứng riêng ở
  section Lệnh thì không báo trạng thái). Mọi nút modal đều dùng size
  `normal` — cỡ nhỏ nhất theo reference Crisp (enum: normal < medium <
  large < wide; KHÔNG có mini) — Ethan chốt 30/10 17:18 sau khi thấy
  large/medium đều quá khổ. Ở màn standalone, hàng link Default /
  Target / Console của mỗi finding rớt xuống thành một hàng ngang
  trong thân dòng (CSS scoped `body.standalone`); bản panel hẹp giữ
  nguyên cột dọc bên phải theo chốt 2026-10-29.
- **Jira**: data một dòng "Jira: Không có / N ticket" (handler
  `tt_jira` — bỏ hẳn 3 ô ticket khai sẵn) ngay trên nút modal **Xem
  ticket Jira**.
- **Lệnh**: Soạn reply (modal, tím) · Private note (modal, cam — enum
  Crisp không có vàng) · Hỏi KB qua chatbot (modal, xanh dương).

Nén (không cắt): 3 ô ticket Jira khai sẵn → 1 dòng `tt_jira` như
trên (đúng chốt 29/10: native chỉ báo số lượng, chi tiết ở modal);
handler `jira_ticket_*` phía server vẫn giữ. Số fetch mỗi lần mở
conversation: **10 → 8**.

URL modal ở pha test mang thêm `&fn=copilot-test` để widget gọi
function test thay vì production; **khi promote lên plugin Copilot CS
thì bỏ tham số này** (test `native-panel.test.js` đang khoá sự hiện
diện của nó — sửa test cùng lúc).

## Dải cảm xúc (copilot_mood_band) — cơ chế CŨ, schema không còn dùng

Bản trước có 4 nút Tâm trạng tĩnh theo dải, hiện/ẩn bằng condition đọc
custom data `copilot_mood_band` (condition của Crisp chỉ đọc dữ liệu
Crisp, không đọc giá trị server trả về). **Ethan bỏ các nút này
30/10 16:26** — CS không cần bấm phân tích lại, điểm tự cập nhật nền.
Việc ghi dải vào custom data (`copilot/mood-band.ts`, các đường
`syncBand` trong analyze/precompute/native) vẫn còn trong code nhưng
nay không còn ai đọc: ứng viên dọn ở vòng promote production. Ngoại
lệ ghi Crisp thứ hai Ethan duyệt 30/10 vì thế cũng hết vai trò.

## Việc cần làm trên Crisp + Supabase (một lần, cho xe test)

1. **Supabase secrets**: `CRISP_PLUGIN_KEY_SURVEY` = **Signing
   Secret** của Production Token của **plugin survey** (trang Tokens —
   mỗi token có 3 trường Identifier / Key / Signing Secret; sự kiện
   widget ký bằng Signing Secret, KHÔNG phải Key — đã kiểm chứng live
   30/10 14:58, trace `key_lens [64,32]`). Function test verify sự
   kiện bằng cả hai khoá (plugin chính + survey); secret là cấp
   project nên `copilot-test` đọc được ngay, code production hiện tại
   không dùng tới key này.
2. **Deploy function `copilot-test`** theo mục "Xe test" ở trên.
3. Vào **Crisp Marketplace → plugin survey → Settings**, thêm một
   **Generic Widget**, dán toàn bộ `widget/native-panel.json` vào ô
   schema.
4. Đặt **Action URL** của plugin survey về URL function TEST:
   `https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot-test`
   (server tự nhận diện sự kiện Generic Widget qua trường `action`
   dạng object và rẽ nhánh trước cả hai cổng auth).
5. Mở thử một conversation: 6 section phải xổ sẵn, data item tự nạp
   (Tâm trạng hiện điểm + nhãn mood dạng chữ, không có nút riêng).

## Hành vi phía server (đã có test khoá)

- **Data fetch**: chỉ đọc DB — không gọi AI đồng bộ. Sentiment
  thiếu/cũ thì fetch trả bản đang lưu (hoặc "Chưa phân tích") và kích
  analyze chạy nền (compute-on-view như panel), kèm đồng bộ dải.
- **Hook CSAT**: nguyên `runSurvey` — claim nguyên tử, cửa sổ chống
  bấm đúp 30 giây, nút không khoá quá cửa sổ đó. Operator resolve từ
  `payload.data.operator_email` → `operators.email`, phải thuộc
  workspace mới gửi.
- **Hook Tâm trạng**: ĐÃ BỎ khỏi schema (30/10 16:26); handler
  `mood_recompute` phía server còn giữ nhưng không sự kiện nào gọi tới.
- **Hook Chatbot**: stub — chỉ ghi trace với cờ `stub: true`.
- **Mọi sự kiện** đều ghi `trace_log` (action `native_fetch` /
  `native_hook`, flow_id dạng `native-<item_id>-…`). Lỗi nghiệp vụ
  luôn trả **200** (kèm trace) để Crisp không retry nhân đôi hành
  động; ngoại lệ duy nhất là chữ ký sai → **401**. Chữ ký verify bằng
  công thức doc `[<timestamp>;<body_as_string>]` HMAC-SHA256, thử mọi
  khoá đã cấu hình; header vắng → chấp nhận + cờ `unsigned`; chưa có
  khoá nào → cờ `signature_unconfigured`.

## Các điểm CHƯA kiểm chứng (đọc trước khi tin là xong)

1. **Condition ở cấp ITEM**: phía ẨN đã kiểm chứng live 30/10 (chưa
   có dải → các nút có condition đều ẩn). Phía HIỆN không còn cần kiểm
   chứng nữa: 4 nút Tâm trạng là nơi duy nhất dùng condition đã bị bỏ
   khỏi schema 30/10 16:26.
2. **PATCH custom data (ghi dải cảm xúc)**: không còn ai đọc từ khi bỏ
   nút Tâm trạng — không cần kiểm chứng thêm; dọn ở vòng promote.
3. **Data item Storefront KHÔNG có hậu tố "· N mới"** của bản thiết
   kế: số finding MỚI không suy được từ bản chụp DB.
4. **Trạng thái Review** đọc từ `outputs` kind `review` — chưa có
   writer ghi kind đó, item hiện "Review: Chưa xin" cho tới khi có
   writer.
5. **Private note là nút MODAL, không phải hook** như board Mapping
   phác: đường điền note bắt buộc chạy qua widget + extension (xác
   nhận 2 lớp ở ô soạn), hook thuần server không chạm được ô soạn.
   Muốn hook thật phải có cơ chế extension nhận lệnh từ server — việc
   riêng, chưa làm.
6. **Modal Storefront/Jira**: deep-link `?open=storefront|jira` hiện
   cuộn tới card tương ứng trong panel (chưa phải màn modal riêng như
   board 5.6/5.7) — vòng "modal gánh design" đang xử lý: widget render
   riêng từng màn theo `?open=`, kèm `fn=copilot-test` + token phụ chỉ
   cho function test.
7. **Nhãn mood rút gọn** trên data item: "Đang bực" thay cho nhãn đầy
   đủ của panel — theo đúng chữ bản thiết kế (chỗ hiển thị hẹp).

## Monitor gộp Storefront + Jira (30/10 17:49)

Nút **Theo dõi Storefront + Jira** (`act_monitor`, `?open=monitor`)
mở MỘT modal chứa cả hai card Storefront và Jira. Modal Crisp thu
nhỏ/di chuyển được và sống xuyên conversation; trang standalone của
monitor tự bám theo conversation đang mở trong inbox:

- Cơ chế: Widget JS SDK (`$crisp.acquireData("conversation")`) mỗi 3
  giây. **Đã kiểm chứng live 30/10 17:49 bằng trang `widget/probe.html`
  + nút tạm "Probe SDK (tạm)" trên plugin survey**: SDK trong modal
  báo đúng conversation đang mở trong inbox, KHÔNG phải conversation
  đóng dấu trong URL lúc mở modal (trạng thái probe lật sang "ĐÃ BÁM
  SANG CHAT KHÁC" sau khi Ethan chuyển chat; cùng trang mở dạng tab
  thường thì SDK im lặng — dữ liệu chỉ chảy qua cầu Crisp trong modal).
- Session khác URL hiện tại → `location.replace` với session mới (giữ
  nguyên token + param Crisp gắn). Đang thao tác Storefront (busy /
  form / menu) thì hoãn sang nhịp hỏi kế tiếp. Chỉ view monitor có cơ
  chế này — draft/note đang gõ không bao giờ bị nạp lại.
- Chồng modal: Crisp mở instance MỚI mỗi lần bấm nút (bắt live 30/10
  17:47). Instance monitor nghe nhau qua BroadcastChannel
  `copilot-monitor` (cùng origin widget): bản mới mở thì bản cũ tự
  `$crisp.closeModal()`. Chưa kiểm chứng live lần đầu — xem vòng test
  monitor.
