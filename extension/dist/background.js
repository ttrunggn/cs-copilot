// Chuyển lệnh chèn từ iframe widget sang top frame của cùng tab (frameId 0 = trang app.crisp.chat).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "copilot:insert" || !sender.tab?.id) return;
  chrome.tabs.sendMessage(sender.tab.id, msg, { frameId: 0 }, (res) => {
    if (chrome.runtime.lastError || !res) {
      sendResponse({ type: "copilot:insert_result", request_id: msg.request_id, status: "composer_not_found" });
    } else {
      sendResponse(res);
    }
  });
  return true;
});
