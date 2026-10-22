// Trạng thái dùng chung của widget. Trước đây là các biến `let` rời ở đầu app.js;
// gom vào một object để extension-client.js và panels.js cùng đọc/ghi được
// mà không cần import vòng về app.js.
export const state = {
  operatorId: "",
  check: null, // kết quả check gần nhất
  draft: null, // { output_id, session_id, vm } — gắn với chat đã soạn
  shownSession: "", // chat đang hiển thị; đổi chat thì xoá draft/handoff cũ
  handoff: null, // { note, posted, cached }
  notice: "", // dòng trạng thái dưới draft/handoff
  choice: false, // đang hỏi Thay thế / Chèn cuối / Huỷ
  draftPlacement: "", // inserted | copied
  knowledgeOpen: false, // panel Hỏi tài liệu đang mở hay đóng (nút ở hàng action bật/tắt)
  askQuestion: "", // câu hỏi CS đang gõ trong panel Hỏi tài liệu (giữ qua các lần render)
  askResult: null, // { question, found, answer, sources } — kết quả ask gần nhất của chat đang mở
  sentiment: null, // phân tích tâm trạng mới nhất (check/analyze/generate trả về)
  sentimentMsgCount: 0, // số tin của khách mà analyze vừa tính sentiment trên đó (0 = chưa biết)
  csat: null, // { sent, sent_at } — trạng thái survey của conversation đang mở
  csatError: false, // lần gửi survey gần nhất lỗi → panel CSAT hiện "Không gửi được / Thử lại"
  hint: "", // ý CS gõ thêm cho draft (gửi kèm generate)
  tone: "default", // giọng văn CS chọn cho draft: default | friendly | formal | concise
  draftEditing: false, // đang sửa draft trực tiếp trong panel
  storefront: null, // dữ liệu Storefront Watch thô; null = chưa nối nguồn (panel hiện trạng thái trống)
  busy: "",
  bridge: "checking", // checking | missing | outdated | ready
  bridgeProbe: null,
};
