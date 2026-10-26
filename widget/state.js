// Trạng thái dùng chung của widget. Trước đây là các biến `let` rời ở đầu app.js;
// gom vào một object để extension-client.js và panels.js cùng đọc/ghi được
// mà không cần import vòng về app.js.
export const state = {
  operatorId: "",
  operatorName: "", // tên account CS đang đăng nhập (từ SDK Crisp) — nguồn chuẩn cho tên trong draft
  check: null, // kết quả check gần nhất
  draft: null, // { output_id, session_id, vm } — gắn với chat đã soạn
  shownSession: "", // chat đang hiển thị; đổi chat thì xoá draft/handoff cũ
  handoff: null, // { note, cached } — note soạn bởi server, điền vào ô Note của Crisp qua extension; copilot không tự đăng
  noteInsertId: "", // output_id tổng hợp cho lệnh điền note — reset khi tạo note mới để khỏi bị chặn "duplicate"
  notePlacement: "", // "" | inserted — note đã được điền vào ô Note của chat đang mở chưa
  notice: "", // dòng trạng thái dưới draft/handoff
  noticeKind: "", // "" | success | error | info — quyết định màu + thời gian tự tắt của notice
  choice: false, // đang hỏi Thay thế / Chèn cuối / Huỷ
  choiceFor: "draft", // lệnh điền đang chờ chọn cách điền thuộc về: draft | review | note | explain
  draftPlacement: "", // "" | inserted
  modal: null, // popup đang mở: null | draft | note | ask | csat | explain (panel gọn v4: thao tác nằm trong popup)
  composeOpen: true, // trong popup Draft: đang hiện form ý + giọng văn hay chỉ hiện draft
  csatChoice: "", // trong popup CSAT: "" | survey | review — CS đã chọn nhánh nào
  reviewText: "", // nội dung tin xin review CS đang sửa trong popup (mặc định REVIEW_TEMPLATE)
  reviewInsertId: "", // output_id tổng hợp cho lệnh điền tin review — reset khi CS sửa chữ để khỏi bị chặn "duplicate"
  draftSugg: null, // gợi ý tối ưu cho draft vừa soạn (generate.draft_suggestion {reason, text}); null = không có
  draftSuggPhase: "", // thẻ gợi ý Draft: "" | trying | adopted | saved (luồng nút Ethan duyệt ở preview v8)
  draftSuggOrig: "", // text draft gốc khi đang thử bản gợi ý — để "Dùng bản gốc" khôi phục
  reviewSuggPhase: "", // thẻ gợi ý Review: "" | trying | adopted | saved
  reviewSuggOrig: "", // text template gốc khi đang thử bản gợi ý Review
  askQuestion: "", // câu hỏi CS đang gõ trong panel Hỏi tài liệu (giữ qua các lần render)
  askResult: null, // { question, found, answer, sources } — kết quả ask gần nhất của chat đang mở
  sentiment: null, // phân tích tâm trạng mới nhất (check/analyze/generate trả về)
  sentimentMsgCount: 0, // số tin của khách mà analyze vừa tính sentiment trên đó (0 = chưa biết)
  sentimentAt: "", // giờ (HH:MM) của lần analyze gần nhất trong phiên — để CS thấy phân tích có chạy thật, không phải số đứng yên
  sentimentRefreshing: false, // panel đang tự làm tươi sentiment vì bản lưu đã cũ (compute-on-view)
  csat: null, // { sent, sent_at } — trạng thái survey của conversation đang mở
  csatError: false, // lần gửi survey gần nhất lỗi → panel CSAT hiện "Không gửi được / Thử lại"
  csatErrorMsg: "", // lý do gửi survey lỗi do server trả về (hiện trong hộp lỗi CSAT)
  hint: "", // ý CS gõ thêm cho draft (gửi kèm generate)
  tone: "default", // giọng văn CS chọn cho draft: default | friendly | formal | concise
  storefront: null, // dữ liệu Storefront Watch do action server trả; null = chưa nạp cho chat này
  storefrontShop: "", // shop (domain/link) đã biết cho chat đang mở — server resolve từ custom data của phiên hoặc CS nhập tay, nhớ theo session
  storefrontShopInput: "", // chữ đang gõ ở ô nhập shop trong module Storefront (giữ qua các lần render)
  storefrontDetail: null, // chi tiết finding đang mở: { fingerprint, ... } hoặc { fingerprint, error }
  storefrontDetailLoading: "", // fingerprint đang tải chi tiết; "" = không tải
  explainText: "", // đoạn mẫu giải thích finding đang mở trong popup Mẫu giải thích (explanationTemplate dựng sẵn)
  explainFinding: null, // finding mà popup Mẫu giải thích đang nói về: { fingerprint, kind, locale, page, text, title }
  explainInsertId: "", // output_id tổng hợp cho lệnh điền mẫu giải thích — reset mỗi lần mở popup cho finding khác
  unlinkConfirm: "", // issue_key đang chờ CS xác nhận gỡ liên kết Jira (bấm "✕ Gỡ" lần 1); "" = không chờ
  busy: "", // nhãn bận hiển thị (thẻ loading chung)
  busyAction: "", // action API đang chạy: generate | handoff | analyze | survey | ask | jira_sync | jira_unlink | storefront ("" = rảnh)
  progress: null, // { action, startedAt } — thẻ tiến trình từng bước khi chờ các action AI
  abortController: null, // AbortController của call đang chạy — nút Huỷ trên thẻ tiến trình dùng nó
  insertPending: false, // đang chờ extension trả lời lệnh điền — khoá các nút điền/chọn cách điền
  bridge: "checking", // checking | missing | outdated | ready
  bridgeProbe: null,
};

/**
 * Xoá toàn bộ trạng thái GẮN VỚI MỘT CHAT khỏi `target` khi đổi conversation.
 * Mọi dữ liệu của khách/chat trước — draft, sentiment, CSAT, handoff, ask,
 * và đặc biệt shop của module Storefront (storefront / storefrontShop /
 * storefrontShopInput / storefrontDetail) — phải về mặc định tại đây, để
 * chat mới không bao giờ nhìn thấy hay dùng lại dữ liệu của chat cũ
 * ("râu ông này cắm cằm bà kia"). app.js gọi hàm này đúng một chỗ: khi
 * session_id của URL khác state.shownSession.
 * Trường KHÔNG xoá (cố ý): operatorId / operatorName (CS đang đăng nhập,
 * không phải dữ liệu của chat), tone (lựa chọn giọng văn của CS),
 * bridge / bridgeProbe (trạng thái extension), busy / progress (luồng đang
 * chạy tự dọn qua stale-guard của call() trong app.js).
 */
export function resetSessionScopedState(target) {
  target.draft = null;
  target.sentiment = null;
  target.sentimentMsgCount = 0;
  target.sentimentAt = "";
  target.sentimentRefreshing = false;
  target.csat = null;
  target.csatError = false;
  target.csatErrorMsg = "";
  target.handoff = null;
  target.modal = null;
  target.csatChoice = "";
  target.reviewText = "";
  target.reviewInsertId = "";
  target.draftSugg = null;
  target.draftSuggPhase = "";
  target.draftSuggOrig = "";
  target.reviewSuggPhase = "";
  target.reviewSuggOrig = "";
  target.composeOpen = true;
  target.askQuestion = "";
  target.askResult = null;
  target.choice = false;
  target.choiceFor = "draft";
  target.unlinkConfirm = "";
  target.storefront = null;
  target.storefrontShop = "";
  target.storefrontShopInput = "";
  target.storefrontDetail = null;
  target.storefrontDetailLoading = "";
  target.explainText = "";
  target.explainFinding = null;
  target.explainInsertId = "";
  target.draftPlacement = "";
  target.hint = "";
  target.notice = "";
  target.noticeKind = "";
  target.noteInsertId = "";
  target.notePlacement = "";
  target.check = null;
  return target;
}
