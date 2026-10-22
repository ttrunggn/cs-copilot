import { handoffStatus, toJiraViewModel } from "./core.js";
import { el } from "./dom.js";
import { state } from "./state.js";

// Các panel hiển thị của widget. Panel chỉ đọc `state` và gọi handler được
// app.js truyền vào ({ copy, onGenerate, onHandoff, sendInsert, detectExtension });
// chúng không tự gọi API hay đổi trạng thái ngoài handler.

/** Hiện draft, tô vàng các chỗ [[CS: …]] để CS không gửi nhầm. */
function draftText(text) {
  const box = el("div", { className: "draft" });
  for (const part of text.split(/(\[\[CS:[^\]]*\]\])/)) {
    if (part) box.append(part.startsWith("[[CS:") ? el("mark", { className: "todo", textContent: part }) : document.createTextNode(part));
  }
  return box;
}

export function extensionHint({ detectExtension }) {
  if (state.bridge === "ready" || state.bridge === "checking") return null;
  const outdated = state.bridge === "outdated";
  const text = outdated ? "Extension cần cập nhật" : "Không nhận diện được extension";
  return el("details", { className: "hint" }, [
    el("summary", { textContent: text }),
    el("strong", { textContent: outdated ? "Tải và cài lại bản extension mới" : "Nếu đã cài, tải lại trang Crisp hoặc bấm kiểm tra lại" }),
    !outdated ? el("button", { className: "button-link", textContent: "Kiểm tra lại", onclick: detectExtension }) : null,
    el("ol", {}, [
      el("li", {}, [el("a", { href: "extension.zip", textContent: "Tải extension.zip", download: "cs-copilot-extension.zip" })]),
      el("li", { textContent: "Giải nén ra một thư mục" }),
      el("li", { textContent: "Mở chrome://extensions, bật Developer mode" }),
      el("li", { textContent: "Bấm Load unpacked, chọn thư mục vừa giải nén, rồi tải lại Crisp" }),
    ]),
  ]);
}

export function draftPanel({ copy, onGenerate, sendInsert }) {
  if (!state.draft) return null;
  const draft = state.draft;
  const vm = draft.vm;
  const actions = el("div", { className: "row draft-actions" }, [
    state.bridge === "ready" ? el("button", { className: "button-primary", textContent: "Điền vào Reply", onclick: () => sendInsert("replace") }) : null,
    el("button", { className: state.bridge === "ready" ? "button-secondary" : "button-primary", textContent: "Copy", onclick: () => copy(vm.text) }),
    el("button", { className: "button-link", textContent: "Soạn lại", disabled: Boolean(state.busy), onclick: () => onGenerate(true) }),
  ]);
  return el("section", { className: "card ai-card draft-card" }, [
    el("div", { className: "draft-heading" }, [
      el("h2", { textContent: "Draft cho tin này" }),
      el("p", { className: state.draftPlacement ? "success-line" : "muted", textContent: state.draftPlacement === "inserted"
        ? "Đã điền draft vào ô Reply, đọc lại rồi bấm Send"
        : state.draftPlacement === "copied"
        ? "Đã copy, dán vào ô Reply bằng Ctrl+V"
        : state.bridge === "ready" ? "Extension sẵn sàng điền draft vào ô Reply" : "Đọc lại draft rồi copy vào ô Reply nhé" }),
    ]),
    el("div", { className: "draft-meta" }, [
      el("span", { className: "muted", textContent: vm.age ? `Soạn ${vm.age}` : "Soạn vừa xong" }),
      el("span", { className: `verify-state ${vm.verified ? "is-ok" : "is-warn"}`, textContent: `${vm.verified ? "✓" : "!"} ${vm.badge}` }),
    ]),
    vm.todos ? el("p", { className: "warn", textContent: `Còn ${vm.todos} chỗ cần bạn điền trước khi gửi` }) : null,
    draftText(vm.text),
    vm.warnings.length
      ? el("div", { className: "warnings" }, vm.warnings.map((w) =>
        el("div", { className: "warning-item" }, [
          el("span", {}, [el("strong", { textContent: "Cần kiểm tra: " }), document.createTextNode(`${w.claim}${w.reason ? `. ${w.reason}` : ""} `)]),
          w.url ? el("a", { href: w.url, target: "_blank", rel: "noopener noreferrer", textContent: "Xem bài" }) : null,
        ])
      ))
      : null,
    actions,
  ]);
}

export function handoffPanel({ copy, onHandoff }) {
  if (!state.handoff) return null;
  const handoff = state.handoff;
  const status = handoffStatus(handoff);
  return el("section", { className: "handoff-card" }, [
    el("div", { className: "row" }, [el("h3", { textContent: "🔒 Private note" }), el("span", { className: handoff.posted ? "verify-state is-ok" : "verify-state is-warn", textContent: handoff.posted ? `✓ ${status}` : status })]),
    el("div", { className: "note-text", textContent: handoff.note }),
    el("div", { className: "row" }, [
      el("button", { className: "button-secondary", textContent: "Copy", onclick: () => copy(handoff.note) }),
      el("button", { className: "button-link", textContent: "Viết lại", disabled: Boolean(state.busy), onclick: () => onHandoff(true) }),
    ]),
  ]);
}

export function jiraPanel() {
  const items = toJiraViewModel(state.check?.jira);
  if (!items.length) return null;
  return el("section", { className: "jira-section" }, [
    el("h2", { className: "section-title", textContent: `Ticket Jira · ${items.length}` }),
    ...items.map((j) =>
    el("div", { className: "jira" }, [
      el("div", { className: "row" }, [
        j.url ? el("a", { href: j.url, target: "_blank", rel: "noopener noreferrer", textContent: j.title }) : el("strong", { textContent: j.title }),
        j.isNew ? el("span", { className: "badge new", textContent: "MỚI" }) : null,
      ]),
      j.summary ? el("p", { className: "muted", textContent: j.summary }) : null,
      j.news.length ? el("ul", { className: "jira-news" }, j.news.map((t) => el("li", { textContent: t }))) : el("p", { className: "muted", textContent: "Chưa có tóm tắt hay cập nhật mới." }),
    ])
    ),
  ]);
}

export function pendingMessageCard(m) {
  const children = [el("p", { textContent: m.text })];
  if (m.imageUrl) {
    const image = el("img", { src: m.imageUrl, alt: "Ảnh khách gửi", loading: "lazy", referrerPolicy: "no-referrer" });
    const fallback = el("span", { className: "image-fallback", textContent: "Không tải được ảnh · Mở ảnh gốc" });
    fallback.hidden = true;
    image.onerror = () => {
      image.hidden = true;
      fallback.hidden = false;
    };
    children.push(el("a", {
      className: "customer-image-link",
      href: m.imageUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Mở ảnh khách gửi ở tab mới",
    }, [image, fallback]));
  }
  if (m.botReplied) children.push(el("span", { className: "bot-replied", textContent: "Bot đã phản hồi · cần CS rà soát" }));
  return el("article", { className: `pending-message${m.imageUrl ? " has-image" : ""}` }, children);
}

/** Các khối dưới đây là UI scaffold theo SPEC v1; chưa gọi API để không giả dữ liệu. */
export function insightPanel() {
  return el("section", { className: "card insight-card future-card" }, [
    el("div", { className: "row" }, [
      el("span", { className: "eyebrow", textContent: "Ý ĐỊNH & TÂM TRẠNG" }),
      el("button", { className: "button-secondary compact-button", textContent: "Phân tích lại", disabled: true, title: "Sẽ nối service sentiment" }),
    ]),
    el("strong", { className: "future-title", textContent: "Chưa có dữ liệu phân tích" }),
    el("p", { className: "muted", textContent: "Ý định, mood và điểm sentiment sẽ hiển thị tại đây sau khi tích hợp." }),
  ]);
}

export function knowledgePanel() {
  if (!state.knowledgeOpen) return null;
  return el("section", { className: "card ai-card knowledge-card future-card" }, [
    el("div", {}, [
      el("h2", { textContent: "Hỏi tài liệu" }),
      el("p", { className: "subtitle", textContent: "Tìm trong FAQ nội bộ, trả lời kèm nguồn" }),
    ]),
    el("textarea", { className: "field", rows: 3, placeholder: "Nhập câu hỏi hoặc vấn đề của khách…", disabled: true }),
    el("p", { className: "muted", textContent: "Tìm kiếm tài liệu sẽ được nối ở bước tiếp theo; không có nguồn thì panel sẽ không đoán chính sách." }),
    el("button", { className: "button-primary", textContent: "Tìm trong tài liệu", disabled: true }),
  ]);
}

export function techPanel() {
  if (!state.handoff) return null;
  return el("section", { className: "card ai-card tech-card future-card" }, [
    el("div", {}, [
      el("h2", { textContent: "Báo Tech" }),
      el("p", { className: "subtitle", textContent: "Chỉ gửi khi CS bấm. Gửi qua Gmail của team." }),
    ]),
    el("div", { className: "field field-static", textContent: "Nội dung email sẽ được tạo từ báo cáo đóng chat và ticket Jira." }),
    el("p", { className: "muted", textContent: "Gmail OAuth, người nhận và trạng thái gửi sẽ được nối sau." }),
    el("button", { className: "button-primary", textContent: "Xem lại và gửi", disabled: true }),
  ]);
}

export function csatPanel() {
  return el("section", { className: "csat-panel future-card" }, [
    el("span", { className: "eyebrow", textContent: "SEND SURVEY" }),
    el("p", { className: "muted", textContent: "Cảnh báo mood và trạng thái đã gửi sẽ hiển thị khi CSAT được nối." }),
    el("button", { className: "csat-button", textContent: "Send CSAT Survey", disabled: true }),
  ]);
}
