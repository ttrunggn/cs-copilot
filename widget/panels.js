import { handoffStatus, toJiraViewModel, toStorefrontViewModel } from "./core.js";
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

const TONE_OPTIONS = [
  ["default", "Mặc định"],
  ["friendly", "Thân thiện"],
  ["formal", "Trang trọng"],
  ["concise", "Ngắn gọn"],
];

export function draftPanel({ copy, onGenerate, sendInsert, saveDraftEdit, toggleDraftEdit }) {
  if (!state.draft) return null;
  const draft = state.draft;
  const vm = draft.vm;
  const busy = Boolean(state.busy);

  // Sửa draft tại chỗ: textarea thay bản đọc; Lưu mới ghi vào state.draft.vm.
  let editor = null;
  let editBox = null;
  if (state.draftEditing) {
    editBox = el("textarea", { className: "field draft-edit", rows: 10, value: vm.text });
    editor = el("div", { className: "draft-editor" }, [
      editBox,
      el("div", { className: "row" }, [
        el("button", { className: "button-primary", textContent: "Lưu", onclick: () => saveDraftEdit(editBox.value) }),
        el("button", { className: "button-secondary", textContent: "Huỷ", onclick: () => saveDraftEdit(null) }),
      ]),
    ]);
  }

  const toneSelect = el("select", {
    className: "tone-select",
    title: "Giọng văn cho draft",
    onchange: (e) => { state.tone = e.target.value; },
  }, TONE_OPTIONS.map(([v, label]) => el("option", { value: v, textContent: label })));
  toneSelect.value = state.tone;

  const hintBox = el("textarea", {
    className: "field draft-hint",
    rows: 2,
    placeholder: "vd: lỗi 502, chờ dev, mai trả lời",
    value: state.hint,
    oninput: (e) => { state.hint = e.target.value; },
  });

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
      el("span", { className: "muted", textContent: vm.age ? `✦ Soạn ${vm.age}` : "✦ Soạn vừa xong" }),
      el("span", { className: `verify-state ${vm.verified ? "is-ok" : "is-warn"}`, textContent: vm.verified ? vm.badge : `! ${vm.badge}` }),
      state.sentiment ? el("span", { className: "muted", textContent: `Đã chỉnh theo mood: ${moodText(state.sentiment)}` }) : null,
    ]),
    vm.sources.length
      ? el("p", { className: "muted draft-sources" }, [
        document.createTextNode("Nguồn helpdesk: "),
        ...vm.sources.flatMap((s, i) => [
          i ? document.createTextNode(" · ") : null,
          el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer", textContent: s.title }),
        ]),
      ])
      : null,
    vm.todos ? el("p", { className: "warn", textContent: `Còn ${vm.todos} chỗ cần điền trước khi gửi.` }) : null,
    editor ?? draftText(vm.text),
    vm.warnings.length
      ? el("div", { className: "warnings" }, vm.warnings.map((w) =>
        el("div", { className: "warning-item" }, [
          el("span", {}, [el("strong", { textContent: "Cần kiểm tra: " }), document.createTextNode(`${w.claim}${w.reason ? `. ${w.reason}` : ""} `)]),
          w.url ? el("a", { href: w.url, target: "_blank", rel: "noopener noreferrer", textContent: "Xem bài" }) : null,
        ])
      ))
      : null,
    el("p", { className: "muted", textContent: "Thêm ý của bạn (không bắt buộc). Để trống thì AI tự soạn từ tin khách; có ý thì ý của bạn được ưu tiên." }),
    hintBox,
    el("div", { className: "row draft-actions" }, [
      el("button", { className: "button-secondary", textContent: "Soạn lại", disabled: busy, onclick: () => onGenerate(true) }),
      toneSelect,
      el("button", { className: "button-secondary", textContent: "Sửa", disabled: busy || state.draftEditing, onclick: toggleDraftEdit }),
    ]),
    el("div", { className: "row draft-actions" }, [
      el("button", { className: state.bridge === "ready" ? "button-secondary" : "button-primary", textContent: "Copy", onclick: () => copy(vm.text) }),
      state.bridge === "ready" ? el("button", { className: "button-primary draft-insert", textContent: "Điền vào Reply", onclick: () => sendInsert("replace") }) : null,
    ]),
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

const MOOD_UI = {
  frustrated: ["😤", "Đang bực / chưa hài lòng"],
  confused: ["😕", "Đang bối rối"],
  neutral: ["😐", "Trung tính"],
  satisfied: ["😊", "Hài lòng"],
  happy: ["😄", "Rất vui"],
};

export function moodText(s) {
  const [emoji, label] = MOOD_UI[s.mood] ?? ["😐", s.mood];
  return `${emoji} ${label} — ${s.score}/100`;
}

/** Hàng chip dưới header: hiện Ý định (topic) khi đã biết. Không có dữ liệu thì không hiện chip. */
export function chipsRow() {
  const topic = state.check?.topic_label ?? state.check?.topic;
  if (!topic) return null;
  return el("div", { className: "chips" }, [
    el("span", { className: "chip" }, [document.createTextNode("Ý định "), el("b", { textContent: topic })]),
  ]);
}

/** Panel Tâm trạng khách — dữ liệu thật từ action analyze (cache theo tin nhắn của khách). */
export function insightPanel({ onAnalyze }) {
  const s = state.sentiment;
  const busy = state.busy.startsWith("Đang phân tích");
  const moodCls = s ? `mood-${s.mood}` : "";
  const fill = s ? el("div", { className: `score-fill mood-bg-${s.mood}` }) : null;
  if (fill) fill.style.width = `${s.score}%`;
  return el("section", { className: "card insight-card" }, [
    el("div", { className: "row" }, [
      el("span", { className: "eyebrow", textContent: "TÂM TRẠNG KHÁCH" }),
      el("button", { className: "button-secondary compact-button", textContent: busy ? "Đang phân tích…" : s ? "Phân tích lại" : "Phân tích", disabled: busy, onclick: () => onAnalyze(true) }),
    ]),
    s
      ? el("div", { className: "mood-row" }, [
        el("b", { className: `mood-label ${moodCls}`, textContent: (MOOD_UI[s.mood] ?? [])[1] ?? s.mood }),
        el("span", {}, [el("b", { className: `score-num ${moodCls}`, textContent: String(s.score) }), el("span", { className: "muted", textContent: "/100" })]),
      ])
      : el("strong", { className: "future-title", textContent: "Chưa có dữ liệu phân tích" }),
    s ? el("div", { className: "score-bar" }, [fill]) : null,
    state.sentimentMsgCount > 0 && s ? el("p", { className: "muted", textContent: `Tính trên ${state.sentimentMsgCount} tin của khách. Cùng chỉ số dùng cho khảo sát CSAT.` }) : null,
    s?.urgency === "high" ? el("p", { className: "warn", textContent: "🔥 Mức khẩn cấp cao — ưu tiên xử lý case này." }) : null,
    s?.summary ? el("p", { className: "muted", textContent: s.summary }) : null,
    ...(s?.signals ?? []).map((t) => el("p", { className: "muted", textContent: `• ${t}` })),
    !s ? el("p", { className: "muted", textContent: "Bấm Phân tích để đọc tâm trạng khách từ đoạn chat; kết quả được nhớ lại, khách nhắn thêm mới tính lại." }) : null,
    s && s.confidence < 0.4 ? el("p", { className: "muted", textContent: "Độ tin cậy thấp (ít tín hiệu) — chỉ tham khảo." }) : null,
  ]);
}

/**
 * Card Tóm tắt ở board 1: hiện khi đã có handoff trong state.
 * Handoff result chỉ có note đã định dạng + trạng thái đăng — hiện nguyên văn,
 * không tách trường (backend không trả summary/issues riêng).
 */
export function summaryPanel({ copy, onHandoff }) {
  if (!state.handoff) return null;
  const handoff = state.handoff;
  return el("section", { className: "card ai-card summary-card" }, [
    el("div", { className: "row" }, [
      el("b", {}, [el("span", { className: "ai-mark", textContent: "✦ " }), document.createTextNode("Tóm tắt")]),
      el("span", { className: "muted", textContent: handoffStatus(handoff) }),
    ]),
    el("div", { className: "summary-note", textContent: handoff.note }),
    el("div", { className: "row summary-actions" }, [
      el("button", { className: "button-secondary compact-button", textContent: "Copy", onclick: () => copy(handoff.note) }),
      el("button", { className: "button-link", textContent: "Viết lại", disabled: Boolean(state.busy), onclick: () => onHandoff(true) }),
    ]),
  ]);
}

/** Các khối dưới đây là UI scaffold theo SPEC v1; chưa gọi API để không giả dữ liệu. */

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

/**
 * Panel CSAT — gửi survey qua action survey (n8n gate giữ key), chống gửi trùng phía server.
 * Cảnh báo điểm thấp chỉ hiện khi khách đang Frustrated VÀ chat chưa đóng
 * (conversation_state từ check; "resolved" = đã đóng).
 */
export function csatPanel({ onSurvey }) {
  const csat = state.csat;
  const s = state.sentiment;
  const busy = state.busy.startsWith("Đang gửi survey");
  const convState = state.check?.conversation_state ?? null;
  const sentTime = csat?.sent_at ? new Date(csat.sent_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "";
  const frustratedOpen = s?.mood === "frustrated" && convState !== "resolved";
  return el("section", { className: "csat-panel" }, [
    el("span", { className: "eyebrow", textContent: "SEND SURVEY" }),
    csat?.sent
      ? el("div", { className: "csat-sent" }, [
        el("p", { className: "success-line", textContent: sentTime ? `✓ Đã gửi lúc ${sentTime}` : "✓ Đã gửi survey" }),
        el("p", { className: "muted", textContent: "Nút gửi đã tắt, chờ khách trả lời." }),
      ])
      : state.csatError
      ? el("div", { className: "csat-error" }, [
        el("b", { textContent: "Không gửi được" }),
        el("p", { className: "muted", textContent: "n8n gate không phản hồi hoặc lỗi kết nối." }),
        el("button", { className: "button-secondary", textContent: "Thử lại", disabled: busy, onclick: () => onSurvey() }),
      ])
      : frustratedOpen
      ? el("p", { className: "warn", textContent: convState
        ? "Chat chưa đóng và khách đang Frustrated. Gửi lúc này dễ nhận điểm thấp."
        : "Khách đang bực — gửi survey lúc này dễ nhận đánh giá thấp. Cân nhắc xử lý xong vấn đề trước." })
      : el("p", { className: "muted", textContent: "Gửi phiếu đánh giá CSAT (4 lựa chọn) vào đoạn chat cho khách." }),
    state.csatError && !csat?.sent
      ? null
      : el("button", { className: "csat-button", textContent: busy ? "Đang gửi…" : "Send CSAT Survey", disabled: Boolean(csat?.sent) || busy, onclick: () => onSurvey() }),
  ]);
}

/**
 * Storefront Watch (board 7): UI đã sẵn, CHƯA có nguồn dữ liệu.
 * state.storefront = null → panel hiện trạng thái trống trung thực, strip không hiện.
 * Khi nối nguồn thật, đổ dữ liệu theo view model ở core.js (toStorefrontViewModel);
 * các nút thao tác trên dữ liệu sẽ được nối handler ở bước đó — hiện để disabled.
 */
export function storefrontStrip() {
  const vm = toStorefrontViewModel(state.storefront);
  if (vm.kind !== "results" || !vm.confirmedCount) return null;
  return el("section", { className: "card storefront-strip" }, [
    el("div", {}, [
      el("b", { className: "error-text", textContent: `Storefront: ${vm.confirmedCount} lỗi đã xác nhận` }),
      vm.scannedLabel ? el("div", { className: "muted", textContent: `Quét ${vm.scannedLabel}` }) : null,
    ]),
    el("span", { className: "link-text", textContent: "Xem" }),
  ]);
}

export function storefrontPanel() {
  const vm = toStorefrontViewModel(state.storefront);
  if (vm.kind === "empty") {
    return el("section", { className: "card storefront-card" }, [
      el("h3", { textContent: "Kiểm tra storefront" }),
      el("p", { className: "muted", textContent: "Chưa có dữ liệu kiểm tra storefront. Tính năng đang chờ nối nguồn dữ liệu Storefront Watch." }),
    ]);
  }
  if (vm.kind === "loading") {
    return el("section", { className: "card storefront-card" }, [
      el("p", { className: "muted", textContent: "Đang kiểm tra store này…" }),
    ]);
  }
  if (vm.kind === "error") {
    return el("section", { className: "card storefront-card error-card" }, [
      el("b", { className: "error-text", textContent: "Công cụ kiểm tra lỗi" }),
      el("button", { className: "button-secondary", textContent: "Thử lại", disabled: true }),
    ]);
  }
  if (vm.kind === "missing-domain") {
    return el("section", { className: "card storefront-card" }, [
      el("p", { textContent: "Chưa nhận ra store của khách này (thiếu shopify domain). Chưa kiểm tra được." }),
    ]);
  }
  return el("section", { className: "card storefront-card" }, [
    el("div", { className: "row" }, [
      vm.confirmedCount
        ? el("b", { className: "error-text", textContent: `${vm.confirmedCount} lỗi đã xác nhận` })
        : el("b", { className: "success-text", textContent: "✓ Không phát hiện lỗi" }),
      vm.scannedLabel ? el("span", { className: "muted", textContent: `Quét ${vm.scannedLabel}` }) : null,
    ]),
    el("p", { className: "muted", textContent: vm.store }),
    ...vm.confirmed.map((d) => el("div", { className: "sf-item" }, [
      el("span", { className: `sf-chip ${d.chipClass}`, textContent: d.chip }),
      el("div", {}, [
        el("div", { textContent: d.title }),
        d.meta ? el("div", { className: "muted", textContent: d.meta }) : null,
      ]),
    ])),
    vm.unverifiedCount ? el("p", { className: "muted sf-collapsed", textContent: `${vm.unverifiedCount} tín hiệu chưa xác minh ▸` }) : null,
    vm.isStale ? el("div", { className: "warn", textContent: "Kết quả cũ. Bấm Kiểm tra lại trước khi dựa vào nó." }) : null,
    el("div", { className: "row" }, [
      el("button", { className: "button-secondary", textContent: "Kiểm tra lại", disabled: true }),
      el("button", { className: "button-secondary", textContent: "Copy tóm tắt", disabled: true }),
    ]),
    el("button", { className: "button-secondary", textContent: "Mở Storefront Watch", disabled: true }),
  ]);
}

/**
 * Suggestion card (Bước 4): hiện khi có tin khách chưa trả lời và chưa có draft.
 * Bấm một cái là generate chạy và draft xổ ra ngay dưới — không tự gọi AI trước,
 * tránh tốn quota cho những case CS không cần.
 */
export function suggestionCard({ onGenerate }, preview) {
  const s = state.sentiment;
  return el("section", { className: "card suggestion-card" }, [
    el("div", { className: "row" }, [
      el("span", { className: "eyebrow", textContent: "💡 GỢI Ý TRẢ LỜI" }),
      s ? el("span", { className: "muted", textContent: moodText(s) }) : null,
    ]),
    preview ? el("p", { className: "suggestion-preview", textContent: preview }) : null,
    el("button", { className: "button-primary", textContent: "Soạn draft cho tin này", disabled: Boolean(state.busy), onclick: () => onGenerate(false) }),
  ]);
}
