// Chạy trong iframe widget (domain Netlify). Cầu nối window.postMessage ↔ chrome.runtime.
const WIDGET_ORIGIN = "__WIDGET_ORIGIN__";
const PROTOCOL = 2; // 2: thêm target "note" cho copilot:insert — widget cũ hiểu là outdated để khỏi điền note vào ô Reply

window.addEventListener("message", (ev) => {
  if (ev.origin !== WIDGET_ORIGIN || !isCopilotMessage(ev, window)) return;
  const m = ev.data;
  if (m.type === "copilot:ping") {
    // Kèm mã định danh của CHÍNH bản cài này (chrome.runtime.id): widget gom
    // mọi pong trong cửa sổ ping — hai mã khác nhau = hai bản extension đang
    // chạy song song trong cùng Chrome (bản cũ chưa gỡ), mỗi lệnh điền bị cả
    // hai cùng thực thi (nội dung gấp đôi, note lỗi).
    window.postMessage({ type: "copilot:pong", protocol: PROTOCOL, version: chrome.runtime.getManifest().version, ext: chrome.runtime.id ?? "" }, WIDGET_ORIGIN);
  } else if (m.type === "copilot:insert") {
    chrome.runtime.sendMessage(m, (res) => {
      const fallback = { type: "copilot:insert_result", request_id: m.request_id, status: "composer_not_found" };
      window.postMessage(chrome.runtime.lastError || !res ? fallback : res, WIDGET_ORIGIN);
    });
  }
});
