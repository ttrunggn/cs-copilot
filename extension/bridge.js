// Chạy trong iframe widget (domain Netlify). Cầu nối window.postMessage ↔ chrome.runtime.
const WIDGET_ORIGIN = "__WIDGET_ORIGIN__";
const PROTOCOL = 2; // 2: thêm target "note" cho copilot:insert — widget cũ hiểu là outdated để khỏi điền note vào ô Reply

window.addEventListener("message", (ev) => {
  if (ev.origin !== WIDGET_ORIGIN || !isCopilotMessage(ev, window)) return;
  const m = ev.data;
  if (m.type === "copilot:ping") {
    window.postMessage({ type: "copilot:pong", protocol: PROTOCOL, version: chrome.runtime.getManifest().version }, WIDGET_ORIGIN);
  } else if (m.type === "copilot:insert") {
    chrome.runtime.sendMessage(m, (res) => {
      const fallback = { type: "copilot:insert_result", request_id: m.request_id, status: "composer_not_found" };
      window.postMessage(chrome.runtime.lastError || !res ? fallback : res, WIDGET_ORIGIN);
    });
  }
});
