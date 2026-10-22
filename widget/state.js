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
  knowledgeOpen: false, // UI scaffold: sẽ nối FAQ search sau
  busy: "",
  bridge: "checking", // checking | missing | outdated | ready
  bridgeProbe: null,
};
