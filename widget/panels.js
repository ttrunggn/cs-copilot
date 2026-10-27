import { actionButtonState, enabledModules, handoffStatus, REVIEW_TEMPLATE, SF_GROUPS, toIssuesViewModel, toJiraViewModel, toStorefrontViewModel } from "./core.js";
import { EXPECTED_EXTENSION_VERSION, extensionOutdated } from "./bridge-core.js";
import { buttonContent, el } from "./dom.js";
import { state } from "./state.js";

// Các panel hiển thị của widget — bố cục panel gọn (preview v4 Ethan duyệt):
// mặc định chỉ xổ 3 module (Tâm trạng khách · Vấn đề của khách · Issue logs
// Storefront/Jira), mỗi module một màu nhận diện; mọi thao tác nằm ở hàng lệnh
// dưới panel và mở popup khi bấm. Panel chỉ đọc `state` và gọi handler được
// app.js truyền vào; chúng không tự gọi API hay đổi trạng thái ngoài handler.

/** Hiện draft, tô vàng các chỗ [[CS: …]] để CS không gửi nhầm. */
function draftText(text) {
  const box = el("div", { className: "draft" });
  for (const part of text.split(/(\[\[CS:[^\]]*\]\])/)) {
    if (part) box.append(part.startsWith("[[CS:") ? el("mark", { className: "todo", textContent: part }) : document.createTextNode(part));
  }
  return box;
}

export function extensionHint({ detectExtension }) {
  // HAI bản extension cùng chạy (hai mã ext khác nhau cùng trả pong): cảnh
  // báo này ưu tiên trên mọi trạng thái khác — chừng nào còn hai bản, mọi
  // lệnh điền đều bị thực thi hai lần và panel không thể báo "sẵn sàng".
  if (state.bridgeConflict) {
    return el("details", { className: "hint warn", open: true }, [
      el("summary", { textContent: "Đang có 2 bản extension cùng chạy" }),
      el("strong", { textContent: "Mỗi lệnh điền bị cả hai bản cùng bấm: ô Reply bị gấp đôi nội dung, ô Note thì lỗi. Gỡ bản cũ, chỉ giữ bản mới nhất." }),
      el("ol", {}, [
        el("li", { textContent: "Mở chrome://extensions" }),
        el("li", { textContent: `Gỡ (Remove) mọi thẻ "CS Copilot — chèn draft" trừ bản v${EXPECTED_EXTENSION_VERSION}` }),
        el("li", { textContent: "Tải lại trang Crisp" }),
      ]),
    ]);
  }
  // Bridge sẵn sàng nhưng SỐ VERSION cũ hơn bản đi kèm widget: vẫn phải
  // cảnh báo (trước đây panel báo "sẵn sàng" vô điều kiện theo protocol,
  // mà protocol không đổi giữa các bản 1.2.x — CS tưởng đã cập nhật trong
  // khi Chrome vẫn chạy bản cũ, lãnh đủ lỗi điền của bản cũ).
  if ((state.bridge === "ready" || state.bridge === "checking") && !extensionOutdated(state.bridgeVersion)) return null;
  if (state.bridge === "ready" || state.bridge === "checking") {
    return el("details", { className: "hint warn", open: true }, [
      el("summary", { textContent: `Extension đang ở bản cũ v${state.bridgeVersion}` }),
      el("strong", { textContent: `Bản mới nhất là ${EXPECTED_EXTENSION_VERSION} — cài lại để điền đúng cách (bản cũ điền kiểu chèn nối, dễ lỗi)` }),
      el("ol", {}, [
        el("li", {}, [el("a", { href: "extension.zip", textContent: "Tải extension.zip", download: "cs-copilot-extension.zip" })]),
        el("li", { textContent: "Mở chrome://extensions, xoá hẳn bản cũ trước" }),
        el("li", { textContent: "Giải nén bản mới, bấm Load unpacked chọn thư mục vừa giải nén, rồi tải lại Crisp" }),
      ]),
    ]);
  }
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

/**
 * Thẻ draft gọn: nội dung + nguồn + cảnh báo, và MỘT hành động duy nhất.
 * Draft đi thẳng vào ô Reply của Crisp qua extension — không còn nút Copy,
 * không sửa trong panel: cần sửa thì sửa ngay tại ô Reply (chỗ CS sẽ bấm
 * Send). Nút "Sửa trong Crisp" cũ đã bỏ (Ethan chê khó hiểu, 2026-10-26) —
 * sau khi điền, nút đổi thành "Điền lại vào Reply". Ý + giọng văn chọn ở
 * form soạn trong popup Draft, trước khi bấm soạn.
 */
/**
 * Thẻ gợi ý tối ưu (Ethan chốt 2026-10-26, preview v8): bản gốc giữ nguyên,
 * thẻ chỉ hiện khi server có gợi ý. Luồng nút đã duyệt: MỘT nút "Thử bản
 * gợi ý" → HAI nút "Dùng bản gợi ý" / "Dùng bản gốc" → nút "Lưu làm mẫu
 * mới" CHỈ xuất hiện sau khi đã chọn dùng bản gợi ý.
 */
export function suggestionCard(kind, handlers) {
  const isDraft = kind === "draft";
  const sugg = isDraft ? state.draftSugg : state.check?.review_template?.suggestion;
  if (!sugg) return null;
  const phase = isDraft ? state.draftSuggPhase : state.reviewSuggPhase;
  if (phase === "saved") {
    return el("div", { className: "sugg-card done" }, [
      el("p", { className: "sugg-stat", textContent: isDraft
        ? "Đã lưu vào profile — các draft sau sẽ ưu tiên cách viết này."
        : "Đã lưu — từ nay bản gợi ý là mẫu review của bạn." }),
    ]);
  }
  // Review: CS đã sửa tay khác hẳn cả bản gốc lẫn bản gợi ý → hết ngữ cảnh gợi ý, ẩn thẻ.
  if (!isDraft && !phase && state.reviewText && state.reviewText !== state.check?.review_template?.text) return null;
  const kids = [
    el("div", { className: "sugg-head" }, [
      el("span", { textContent: "Gợi ý tối ưu từ Copilot" }),
      el("span", { className: "muted", textContent: "không bắt buộc" }),
    ]),
    el("p", { className: "sugg-reason", textContent: sugg.reason }),
  ];
  if (phase === "trying") {
    kids.push(el("p", { className: "sugg-stat", textContent: "Đang xem trước bản gợi ý, chọn dùng bản nào:" }));
    kids.push(el("div", { className: "row sugg-actions" }, [
      el("button", { className: "button-primary", textContent: "Dùng bản gợi ý", onclick: () => handlers.onSuggAdopt(kind) }),
      el("button", { className: "button-secondary", textContent: "Dùng bản gốc", onclick: () => handlers.onSuggOrig(kind) }),
    ]));
  } else if (phase === "adopted") {
    kids.push(el("p", { className: "sugg-stat", textContent: "Đang dùng bản gợi ý cho lần này." }));
    kids.push(el("div", { className: "row sugg-actions" }, [
      el("button", { className: "button-secondary", textContent: "Lưu làm mẫu mới", onclick: () => handlers.onSuggSave(kind) }),
    ]));
  } else {
    kids.push(el("div", { className: "row sugg-actions" }, [
      el("button", { className: "button-primary", textContent: "Thử bản gợi ý", onclick: () => handlers.onSuggTry(kind) }),
    ]));
  }
  return el("div", { className: "sugg-card" }, kids);
}

export function draftPanel(handlers) {
  if (!state.draft) return null;
  const draft = state.draft;
  const vm = draft.vm;
  const onEditInCrisp = handlers.onEditInCrisp;

  return el("section", { className: "card ai-card draft-card" }, [
    el("div", { className: "draft-heading" }, [
      el("h2", { textContent: "Draft cho tin này" }),
      el("p", { className: state.draftPlacement ? "success-line" : "muted", textContent: state.draftPlacement === "inserted"
        ? "Đã điền draft vào ô Reply, đọc lại rồi bấm Send"
        : state.bridge === "ready" ? `Extension sẵn sàng điền draft vào ô Reply${state.bridgeVersion ? ` · v${state.bridgeVersion}` : ""}` : "Cài extension để điền draft thẳng vào ô Reply nhé" }),
    ]),
    el("div", { className: "draft-meta" }, [
      el("span", { className: "muted", textContent: vm.age ? `Soạn ${vm.age}` : "Soạn vừa xong" }),
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
    draftText(vm.text),
    suggestionCard("draft", handlers),
    vm.warnings.length
      ? el("div", { className: "warnings" }, vm.warnings.map((w) =>
        el("div", { className: "warning-item" }, [
          el("span", {}, [el("strong", { textContent: "Cần kiểm tra: " }), document.createTextNode(`${w.claim}${w.reason ? `. ${w.reason}` : ""} `)]),
          w.url ? el("a", { href: w.url, target: "_blank", rel: "noopener noreferrer", textContent: "Xem bài" }) : null,
        ])
      ))
      : null,
    // Thanh chọn Thay thế/Huỷ đang mở cho draft thì ẩn nút điền: hai lớp
    // nút chồng nhau gây khó hiểu (Ethan bắt live 2026-10-26 ở cả popup
    // Draft lẫn Xin review).
    state.bridge === "ready" && !(state.choice && state.choiceFor === "draft")
      ? el("div", { className: "row draft-actions single" }, [
        state.draftPlacement === "inserted"
          ? el("button", { className: "button-secondary", textContent: "Điền lại vào Reply", disabled: state.insertPending, onclick: () => onEditInCrisp() })
          : el("button", { className: "button-primary draft-insert", textContent: "Điền vào Reply", disabled: state.insertPending, onclick: () => onEditInCrisp() }),
      ])
      : null,
  ]);
}

/**
 * Private note: thẻ vàng hổ phách pha loãng (Ethan chốt lại 2026-10-23 — vàng
 * là màu nhận diện private note như trong Crisp; biểu tượng khoá vẫn bỏ).
 * Copilot KHÔNG tự đăng note: note được ĐIỀN VÀO Ô NOTE của Crisp qua
 * extension (extension tự bấm tab Note và chỉ điền khi đã xác nhận Note
 * mode), CS sửa ngay trong ô Note rồi tự đăng. Không còn nút Copy — panel
 * chỉ còn đường insert vào ô soạn (Ethan chốt UX 2026-10-23).
 */
export function handoffPanel({ onHandoff, onInsertNote }) {
  if (!state.handoff) return null;
  const handoff = state.handoff;
  const status = handoffStatus(handoff);
  const noteBtn = actionButtonState(state.busyAction, "handoff");
  const inserted = state.notePlacement === "inserted";
  return el("section", { className: "handoff-card" }, [
    el("div", { className: "row" }, [el("h3", { textContent: "Private note" }), el("span", { className: "verify-state", textContent: status })]),
    el("p", { className: inserted ? "success-line" : "muted", textContent: inserted
      ? "Đã điền note vào ô Note, sửa lại rồi tự đăng trong Crisp"
      : state.bridge === "ready" ? `Extension sẵn sàng điền note vào ô Note${state.bridgeVersion ? ` · v${state.bridgeVersion}` : ""}` : "Cài extension để điền note thẳng vào ô Note của Crisp nhé" }),
    el("div", { className: "note-text", textContent: handoff.note }),
    el("div", { className: "row" }, [
      state.bridge === "ready" && !(state.choice && state.choiceFor === "note")
        ? el("button", { className: inserted ? "button-secondary" : "button-primary", textContent: inserted ? "Điền lại vào ô Note" : "Điền vào ô Note", disabled: state.insertPending, onclick: () => onInsertNote() })
        : null,
      el("button", { className: "button-link", disabled: noteBtn.disabled, onclick: () => onHandoff(true) }, buttonContent(noteBtn.running, "Đang viết…", "Viết lại")),
    ]),
  ]);
}

/**
 * Module Jira (màu xanh dương): chỉ hiện khi server bật module Jira trong
 * check.modules (chat có ticket liên kết đang active). UI theo mẫu Ethan
 * chốt 2026-10-26: mỗi ticket một card — tiêu đề "Jira - {tên ticket}",
 * pill Status bên phải, dòng "{KEY} · Cập nhật …", comment mới nhất của
 * team Tech. Badge "Cập nhật mới" khi có thay đổi sau lần CS trả lời gần
 * nhất; ticket Done chưa báo khách ở lại với nhãn "Chờ báo khách" (Done
 * trên Jira không có nghĩa khách đã được báo). Hai thao tác: "↻ Sync ngay"
 * (server đồng bộ ngay rồi panel nạp lại) và "✕ Gỡ" từng ticket (xác nhận 2
 * bước tại chỗ).
 */
export function jiraPanel({ onJiraSync, onJiraUnlink, rerender }) {
  if (!enabledModules(state.check).jira) return null;
  const items = toJiraViewModel(state.check?.jira);
  const syncBtn = actionButtonState(state.busyAction, "jira_sync");
  const unlinkBtn = actionButtonState(state.busyAction, "jira_unlink");
  if (!items.length) {
    return el("div", { className: "jira-section" }, [
      el("section", { className: "card mod-jira jira-card" }, [
        el("strong", { className: "jira-title", textContent: "Jira" }),
        el("p", { className: "muted", textContent: "Không có ticket Jira." }),
      ]),
    ]);
  }
  return el("div", { className: "jira-section" }, [
    el("div", { className: "jira-toolbar" }, [
      el("button", { className: "button-secondary compact-button", disabled: syncBtn.disabled, onclick: () => onJiraSync() }, buttonContent(syncBtn.running, "Đang đồng bộ…", "↻ Sync ngay")),
    ]),
    ...items.map((j) =>
    el("section", { className: "card mod-jira jira-card" }, [
      el("div", { className: "row" }, [
        j.url ? el("a", { className: "jira-title", href: j.url, target: "_blank", rel: "noopener noreferrer", textContent: `Jira - ${j.name}` }) : el("strong", { className: "jira-title", textContent: `Jira - ${j.name}` }),
        el("span", { className: `pill-status${j.done ? " done" : ""}`, textContent: j.status }),
      ]),
      el("p", { className: "muted", textContent: j.updatedLabel ? `${j.key} · ${j.updatedLabel}` : j.key }),
      j.hasUpdate || j.awaitingReport ? el("div", { className: "row jira-badges" }, [
        j.hasUpdate ? el("span", { className: "badge new", textContent: "Cập nhật mới" }) : null,
        j.awaitingReport ? el("span", { className: "badge wait", textContent: "Chờ báo khách" }) : null,
      ]) : null,
      j.statusLine ? el("p", { className: "muted", textContent: j.statusLine }) : null,
      j.latestTech ? el("div", { className: "jira-comment" }, [
        el("p", {}, [
          el("b", { textContent: `Tech · ${j.latestTech.author}` }),
          document.createTextNode(" "),
          el("span", { className: "muted", textContent: `(${j.latestTech.ago})` }),
        ]),
        el("p", { textContent: j.latestTech.body }),
      ]) : null,
      el("div", { className: "jira-actions" }, [
        state.unlinkConfirm === j.key
          ? el("span", { className: "unlink-confirm" }, [
            el("button", { className: "button-secondary compact-button", disabled: unlinkBtn.disabled, onclick: () => onJiraUnlink(j.key) }, buttonContent(unlinkBtn.running, "Đang gỡ…", "Gỡ liên kết này?")),
            el("button", { className: "button-link", onclick: () => { state.unlinkConfirm = ""; rerender(); } }, [document.createTextNode("Huỷ")]),
          ])
          : el("button", { className: "button-link unlink-button", onclick: () => { state.unlinkConfirm = j.key; rerender(); } }, [document.createTextNode("✕ Gỡ")]),
      ]),
    ])
    ),
  ]);
}


// Nhãn tâm trạng: chỉ chữ, không emoji mặt cảm xúc (Ethan chốt: bỏ icon
// trang trí khỏi nội dung hiển thị — cần phân biệt thì đã có màu module).
const MOOD_LABELS = {
  frustrated: "Đang bực / chưa hài lòng",
  confused: "Đang bối rối",
  neutral: "Trung tính",
  satisfied: "Hài lòng",
  happy: "Rất vui",
};

export function moodText(s) {
  const label = MOOD_LABELS[s.mood] ?? s.mood;
  return `${label} — ${s.score}/100`;
}

/* Hàng chip dưới header đã bỏ hẳn (Ethan 2026-10-23: chip "Ý định" trông kỳ).
   Chip Ngôn ngữ trong preview v4 chỉ là chữ tĩnh của bản mock — widget thật
   không có dữ liệu ngôn ngữ khách trong check nên không dựng chip giả. */

/** Module Tâm trạng khách (màu tím) — dữ liệu thật từ check/analyze/generate, kèm dòng tóm tắt (sentiment.summary). */
export function insightPanel({ onAnalyze }) {
  const s = state.sentiment;
  const anBtn = actionButtonState(state.busyAction, "analyze");
  const moodCls = s ? `mood-${s.mood}` : "";
  const fill = s ? el("div", { className: `score-fill mood-bg-${s.mood}` }) : null;
  if (fill) fill.style.width = `${s.score}%`;
  return el("section", { className: "card insight-card mod-sent" }, [
    el("div", { className: "row" }, [
      el("span", { className: "eyebrow", textContent: "TÂM TRẠNG KHÁCH" }),
      el("button", { className: "button-secondary compact-button", disabled: anBtn.disabled, onclick: () => onAnalyze(true) }, buttonContent(anBtn.running, "Đang phân tích…", s ? "Phân tích lại" : "Phân tích")),
    ]),
    s
      ? el("div", { className: "mood-row" }, [
        el("b", { className: `mood-label ${moodCls}`, textContent: MOOD_LABELS[s.mood] ?? s.mood }),
        el("span", {}, [el("b", { className: `score-num ${moodCls}`, textContent: String(s.score) }), el("span", { className: "muted", textContent: "/100" })]),
      ])
      : el("strong", { className: "future-title", textContent: "Chưa có dữ liệu phân tích" }),
    s ? el("div", { className: "score-bar" }, [fill]) : null,
    state.sentimentRefreshing ? el("p", { className: "muted", textContent: "Đang cập nhật phân tích theo tin mới nhất…" }) : null,
    s?.urgency === "high" ? el("p", { className: "warn", textContent: "Mức khẩn cấp cao — ưu tiên xử lý case này." }) : null,
    s?.summary ? el("p", { className: "muted", textContent: s.summary }) : null,
    ...(s?.signals ?? []).map((t) => el("p", { className: "muted", textContent: `• ${t}` })),
    !s ? el("p", { className: "muted", textContent: "Chưa có dữ liệu phân tích." }) : null,
    s && s.confidence < 0.4 ? el("p", { className: "muted", textContent: "Độ tin cậy thấp (ít tín hiệu) — chỉ tham khảo." }) : null,
  ]);
}

/**
 * Module Vấn đề của khách (màu cam đào — Ethan chốt lại cấu trúc 2026-10-23):
 * một dòng tiêu đề nhỏ "VẤN ĐỀ CỦA KHÁCH — N issues", dưới đó MỖI issue là
 * một card riêng mang nhãn "ISSUE 1", "ISSUE 2", … (nhãn + chấm cùng tông
 * cam đào, card có vệt accent .mod-issues như các module khác). Nguyên văn
 * tin khách đang chờ nằm trong card riêng ở cuối cụm. Issue lấy từ
 * sentiment.issues (câu tóm tắt vấn đề + dòng bằng chứng), lùi về topic khi
 * chưa có (toIssuesViewModel ở core.js), chỉ đổi cách render ở đây.
 */


export function issuesPanel(vm) {
  const { issues } = toIssuesViewModel(state.check, state.sentiment);
  // Badge lỗi storefront đang mở của store thuộc chat này — để CS thấy ngay
  // ở khối Issue logs mà không cần mở module Storefront hay tự đi search
  // (điểm mù Ethan chỉ ra: SW quét theo domain, không search là không biết).
  // Nguồn ưu tiên: tổng finding thật từ module đã nạp (trước gom nhóm);
  // chưa nạp thì dùng bản chụp nền trong check.storefront_status. Badge vẫn
  // tôn trọng cổng module: cổng Storefront tắt thì không rò số liệu SW.
  const sfVm = state.storefront ? toStorefrontViewModel(state.storefront) : null;
  const sfOpen = !enabledModules(state.check).storefront
    ? 0
    : sfVm?.kind === "results"
    ? sfVm.totalCount
    : (state.check?.storefront_status?.watched ? (state.check.storefront_status.open_total ?? 0) : 0);
  // Không issue đã tóm tắt và không badge Storefront thì ẩn hẳn module —
  // thẻ "Hết tin chờ rồi" cũ bỏ: header panel đã nói trạng thái tin chờ.
  if (!issues.length && !sfOpen) return null;
  return el("div", { className: "issues-module" }, [
    el("div", { className: "issues-head" }, [
      el("span", { className: "eyebrow", textContent: "VẤN ĐỀ CỦA KHÁCH" }),
      issues.length ? el("span", { className: "muted", textContent: `— ${issues.length} issues` }) : null,
      sfOpen > 0 ? el("span", { className: "badge new sf-badge", textContent: `Storefront: ${sfOpen} lỗi đang mở` }) : null,
    ]),
    ...issues.map((issue, i) => el("section", { className: "card mod-issues issue-card" }, [
      el("span", { className: "issue-tag" }, [
        el("span", { className: "dot" }),
        document.createTextNode(`ISSUE ${i + 1}`),
      ]),
      el("b", { textContent: issue.title }),
      issue.detail ? el("div", { className: "muted", textContent: issue.detail }) : null,
    ])),
  ]);
}

/**
 * Panel Hỏi tài liệu (trong popup Knowledge Base Asking): CS gõ câu hỏi →
 * action ask trả lời CHỈ từ helpdesk, kèm nguồn. Không tìm thấy thì không
 * hiện thêm khối nào (Ethan chốt 2026-10-27: bỏ thẻ "không tìm thấy" cùng hai
 * nút Thử từ khoá khác / Ghi private note hỏi quản lý). "Soạn thành tin trả
 * lời khách" đưa đáp án thành ý của CS (state.hint) rồi chạy generate như
 * thường. Không còn nút Copy (Ethan chốt UX 2026-10-23): muốn dùng đáp án
 * thì đi đường "Soạn thành tin trả lời khách".
 */
export function knowledgePanel({ onAsk, onAskCompose }) {
  const r = state.askResult;
  const askBtn = actionButtonState(state.busyAction, "ask");
  const genBtn = actionButtonState(state.busyAction, "generate");
  const input = el("textarea", {
    className: "field",
    rows: 3,
    placeholder: "Nhập câu hỏi hoặc vấn đề của khách…",
    value: state.askQuestion,
    oninput: (e) => { state.askQuestion = e.target.value; },
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onAsk();
      }
    },
  });
  return el("section", { className: "card ai-card knowledge-card" }, [
    el("div", {}, [
      el("h2", { textContent: "Knowledge Base Asking" }),
      el("p", { className: "subtitle", textContent: "Tìm trong FAQ nội bộ, trả lời kèm nguồn" }),
    ]),
    input,
    el("button", { className: "button-primary", disabled: askBtn.disabled, onclick: () => onAsk() }, buttonContent(askBtn.running, "Đang tìm…", "Tìm trong tài liệu")),
    r ? el("div", { className: "ask-question", textContent: r.question }) : null,
    r && r.found ? el("div", { className: "ask-answer-block" }, [
      el("div", { className: "ask-answer", textContent: r.answer }),
      r.sources.length ? el("p", { className: "muted ask-sources" }, [
        document.createTextNode("Nguồn: "),
        ...r.sources.flatMap((s, i) => [
          i ? document.createTextNode(" · ") : null,
          el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer", textContent: s.title }),
        ]),
      ]) : null,
      el("div", { className: "row" }, [
        el("button", { className: "button-primary", disabled: genBtn.disabled, onclick: () => onAskCompose(r.answer) }, buttonContent(genBtn.running, state.busy, "Soạn thành tin trả lời khách")),
      ]),
    ]) : null,
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
  const svBtn = actionButtonState(state.busyAction, "survey");
  const convState = state.check?.conversation_state ?? null;
  const sentTime = csat?.sent_at ? new Date(csat.sent_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "";
  const frustratedOpen = s?.mood === "frustrated" && convState !== "resolved";
  return el("section", { className: "csat-panel" }, [
    el("span", { className: "eyebrow", textContent: "SEND SURVEY" }),
    csat?.sent
      ? el("div", { className: "csat-sent" }, [
        el("p", { className: "success-line", textContent: sentTime ? `✓ Đã gửi lúc ${sentTime}` : "✓ Đã gửi survey" }),
      ])
      : state.csatError
      ? el("div", { className: "csat-error" }, [
        el("b", { textContent: "Không gửi được" }),
        el("p", { className: "muted", textContent: state.csatErrorMsg || "n8n gate không phản hồi hoặc lỗi kết nối." }),
        el("button", { className: "button-secondary", disabled: svBtn.disabled, onclick: () => onSurvey() }, buttonContent(svBtn.running, "Đang gửi…", "Thử lại")),
      ])
      : frustratedOpen
      ? el("p", { className: "warn", textContent: convState
        ? "Chat chưa đóng và khách đang Frustrated. Gửi lúc này dễ nhận điểm thấp."
        : "Khách đang bực — gửi survey lúc này dễ nhận đánh giá thấp. Cân nhắc xử lý xong vấn đề trước." })
      : null,
    state.csatError && !csat?.sent
      ? null
      : el("button", { className: "csat-button", disabled: svBtn.disabled, onclick: () => onSurvey() }, buttonContent(svBtn.running, "Đang gửi…", csat?.sent ? "Gửi lại CSAT Survey" : "Send CSAT Survey")),
  ]);
}

/** Class màu pill theo trạng thái Storefront. */
const SF_STATUS_CLASS = { new: "sf-new", acknowledged: "sf-ack", in_progress: "sf-prog" };

/** Form ghi chú trong menu thao tác: Fixed chỉ cần ghi chú; Dismiss thêm 2 lựa chọn lý do (đúng 2 giá trị schema SW nhận). */
function sfActForm(row, kind, handlers) {
  const fp = row.fingerprint;
  const busy = state.sfActBusy === fp;
  const valid = () => state.sfNoteInput.trim().length > 0 && (kind === "fixed" || Boolean(state.sfReason));
  const confirmBtn = el("button", {
    className: "sf-act sf-confirm",
    disabled: busy || !valid(),
    onclick: () => handlers.onStorefrontAct?.(fp, kind),
  }, buttonContent(busy, "Đang gửi…", kind === "fixed" ? "Xác nhận Fixed" : "Xác nhận Dismiss"));
  return el("div", { className: "sf-form" }, [
    kind === "dismiss" ? el("div", { className: "sf-flabel", textContent: "Lý do Dismiss (bắt buộc)" }) : null,
    kind === "dismiss" ? el("div", { className: "sf-chips" }, [
      el("button", {
        className: `sf-chip${state.sfReason === "false_signal" ? " on" : ""}`,
        textContent: "Báo sai, trang vẫn ổn",
        onclick: () => { state.sfReason = "false_signal"; handlers.rerender?.(); },
      }),
      el("button", {
        className: `sf-chip${state.sfReason === "not_important" ? " on" : ""}`,
        textContent: "Lỗi thật, không đáng sửa",
        onclick: () => { state.sfReason = "not_important"; handlers.rerender?.(); },
      }),
    ]) : null,
    el("textarea", {
      className: "sf-note-input",
      rows: 2,
      placeholder: "Ghi chú (bắt buộc) — Console hiện ghi chú này kèm quyết định",
      value: state.sfNoteInput,
      // Gõ ghi chú không render lại (mất focus); chỉ bật/tắt nút xác nhận tại chỗ.
      oninput: (e) => {
        state.sfNoteInput = e.target.value;
        confirmBtn.disabled = busy || !valid();
      },
    }),
    el("div", { className: "sf-fbtns" }, [
      confirmBtn,
      el("button", { className: "sf-act", disabled: busy, textContent: "Huỷ", onclick: () => handlers.onStorefrontForm?.(fp, null) }),
    ]),
  ]);
}

/**
 * Một dòng bug (Ethan chốt lại 2026-10-26 23:24): pill trạng thái (Mới / Đã
 * xác nhận / Đang xử lý — Đang xử lý = team đã báo khách, server tự phân
 * loại) + nhãn bug ngắn + meta dữ kiện + đúng 1 link ↗ unit sang Console.
 * Không hiện nội dung/message của SW trong panel.
 * Từ 2026-10-27 (SW mở scope write, Ethan duyệt bản giả lập): bấm vào dòng
 * mở MENU THAO TÁC ngay dưới dòng — Acknowledge (trái nhất, một chạm) ·
 * Fixed · Dismiss (cả hai qua form ghi chú phía server bắt buộc); finding
 * vừa đóng trong phiên panel hiện ghi chú kèm quyết định + nút Mở lại.
 */
function sfRow(row, handlers = {}) {
  const fp = row.fingerprint;
  const closed = fp ? state.sfClosed[fp] : null;
  const busy = Boolean(fp) && state.sfActBusy === fp;
  const kids = [
    el("div", {
      className: "sf-line sf-clickable",
      onclick: (e) => {
        if (typeof e.target?.closest === "function" && e.target.closest("a, button")) return;
        handlers.onStorefrontMenu?.(fp);
      },
    }, [
      el("span", { className: `pill-sf ${closed ? "sf-closed" : SF_STATUS_CLASS[row.status] ?? ""}`, textContent: closed ? "Đã đóng" : row.pill }),
      el("div", {}, [
        el("div", { textContent: row.shortLabel }),
        row.meta ? el("div", { className: "muted", textContent: row.meta }) : null,
      ]),
      row.consoleLink && /^https:\/\//.test(row.consoleLink)
        ? el("a", { className: "sf-bug-link", href: row.consoleLink, target: "_blank", rel: "noreferrer", textContent: "↗", title: "Mở bug này trong Storefront Watch" })
        : null,
    ]),
  ];
  if (closed) {
    kids.push(el("div", {
      className: "sf-closed-note",
      textContent: `${closed.via === "fixed" ? "Fixed" : "Dismiss"} · ${state.operatorName || "CS"}: “${closed.note}”`,
    }));
    kids.push(el("button", {
      className: "sf-undo",
      disabled: busy,
      onclick: () => handlers.onStorefrontAct?.(fp, "undo"),
    }, buttonContent(busy, "Đang mở lại…", "Mở lại")));
    return el("div", { className: "sf-item" }, kids);
  }
  if (fp && state.sfMenu === fp) {
    kids.push(el("div", { className: "sf-menu" }, [
      el("div", { className: "sf-actions" }, [
        row.status !== "in_progress"
          ? el("button", { className: "sf-act sf-act-ack", disabled: busy, onclick: () => handlers.onStorefrontAct?.(fp, "acknowledge") },
            buttonContent(busy, "Đang gửi…", "Acknowledge"))
          : null,
        el("button", { className: "sf-act", disabled: busy, textContent: "Fixed", onclick: () => handlers.onStorefrontForm?.(fp, "fixed") }),
        el("button", { className: "sf-act", disabled: busy, textContent: "Dismiss", onclick: () => handlers.onStorefrontForm?.(fp, "dismiss") }),
      ]),
      state.sfForm?.fingerprint === fp ? sfActForm(row, state.sfForm.kind, handlers) : null,
    ]));
  }
  return el("div", { className: "sf-item" }, kids);
}

export function storefrontPanel(handlers = {}) {
  if (!enabledModules(state.check).storefront) return null;
  const vm = toStorefrontViewModel(state.storefront);
  const sfBtn = actionButtonState(state.busyAction, "storefront");
  if (vm.kind === "empty") {
    return el("section", { className: "card storefront-card mod-store" }, [
      el("h3", { textContent: "Storefront Watch" }),
      el("p", { className: "muted", textContent: "Chưa có dữ liệu kiểm tra storefront cho chat này." }),
    ]);
  }
  if (vm.kind === "need-shop") {
    return el("section", { className: "card storefront-card mod-store" }, [
      el("h3", { textContent: "Storefront Watch" }),
      el("p", { className: "muted", textContent: "Nhập domain Shopify của store:" }),
      el("input", {
        className: "input",
        type: "text",
        placeholder: "vd: store-abc.myshopify.com",
        value: state.storefrontShopInput,
        oninput: (e) => { state.storefrontShopInput = e.target.value; },
        onkeydown: (e) => { if (e.key === "Enter") handlers.onStorefrontLoad?.(); },
      }),
      el("button", { className: "button-secondary", disabled: sfBtn.disabled, onclick: () => handlers.onStorefrontLoad?.() },
        buttonContent(sfBtn.running, "Đang kiểm tra…", "Kiểm tra store này")),
    ]);
  }
  if (vm.kind === "loading") {
    return el("section", { className: "card storefront-card mod-store" }, [
      el("h3", { textContent: "Storefront Watch" }),
      el("p", { className: "muted", textContent: "Đang kiểm tra store này…" }),
    ]);
  }
  if (vm.kind === "unconfigured") {
    return el("section", { className: "card storefront-card mod-store" }, [
      el("h3", { textContent: "Storefront Watch" }),
      el("p", { className: "muted", textContent: vm.message ?? "Storefront Watch chưa được cấu hình trên server." }),
    ]);
  }
  if (vm.kind === "error") {
    return el("section", { className: "card storefront-card mod-store error-card" }, [
      el("b", { className: "error-text", textContent: "Không kiểm tra được storefront" }),
      vm.message ? el("p", { className: "muted", textContent: vm.message }) : null,
      el("button", { className: "button-secondary", textContent: "Thử lại", disabled: sfBtn.disabled, onclick: () => handlers.onStorefrontLoad?.() }),
    ]);
  }
  if (vm.kind === "missing-domain") {
    return el("section", { className: "card storefront-card mod-store" }, [
      el("p", { textContent: "Chưa nhận ra store của khách này (thiếu shopify domain). Chưa kiểm tra được." }),
    ]);
  }
  // Card Storefront rút còn đúng bản TỔNG HỢP (Ethan chốt 2026-10-26 20:16):
  // domain này có lỗi hay không + tổng số lỗi, và MỘT nút sang thẳng
  // Storefront Watch. Không liệt kê từng bug, không hiện nội dung/message
  // của SW — CS bấm sang Console chủ yếu để xem 2 ảnh chụp của tool.
  // Số lỗi còn mở trừ đi các finding CS vừa đóng ngay trong phiên panel này
  // (dữ liệu server chưa nạp lại) — con số trên đầu thẻ phải khớp mắt nhìn.
  const closedHere = new Set((vm.rows ?? []).map((r) => r.fingerprint).filter((fp) => fp && state.sfClosed[fp]));
  const openNow = Math.max(0, (vm.totalCount ?? 0) - closedHere.size);
  return el("section", { className: "card storefront-card mod-store" }, [
    el("div", { className: "row sf-head" }, [
      vm.notWatched
        ? el("b", { textContent: "Storefront Watch — chưa theo dõi store này" })
        : openNow
        ? el("b", { className: "error-text", textContent: `${openNow} lỗi đã xác nhận` })
        : el("b", { className: "success-text", textContent: "✓ Không phát hiện lỗi" }),
      el("a", { className: "button-secondary sf-open", href: "https://sw.transcy.io", target: "_blank", rel: "noreferrer", textContent: "Mở Storefront Watch ↗" }),
    ]),
    vm.scannedLabel ? el("p", { className: "muted", textContent: `Quét ${vm.scannedLabel}` }) : null,
    vm.notWatched
      ? el("p", { className: "muted", textContent: "Store chưa được Storefront Watch theo dõi." })
      : null,
    el("div", { className: "sf-rows" }, (vm.rows ?? []).map((r) => sfRow(r, handlers))),
    state.sfMsg ? el("p", { className: "muted sf-msg", textContent: state.sfMsg }) : null,
    !vm.notWatched
      ? el("div", { className: "row sf-footer" }, [
        el("button", { className: "button-secondary", disabled: sfBtn.disabled, onclick: () => handlers.onStorefrontLoad?.() },
          buttonContent(sfBtn.running, "Đang kiểm tra…", "Kiểm tra lại")),
      ])
      : null,
  ]);
}

// ---------- hàng lệnh + popup (panel gọn v4) ----------

/** Hàng lệnh dưới panel: mỗi nút một sắc nhạt riêng; bấm mở popup tương ứng. */
export function commandsRow({ onOpenModal }) {
  return el("div", { className: "cmds" }, [
    el("button", { className: "cmd cmd-draft", textContent: "Draft", onclick: () => onOpenModal("draft") }),
    el("button", { className: "cmd cmd-note", textContent: "Private note", onclick: () => onOpenModal("note") }),
    el("button", { className: "cmd cmd-ask", textContent: "Knowledge Base Asking", onclick: () => onOpenModal("ask") }),
    el("button", { className: "cmd cmd-csat", textContent: "Xin CSAT / Review", onclick: () => onOpenModal("csat") }),
  ]);
}

const TONE_OPTIONS = [
  // "Mặc định" phải nói rõ là theo profile đã học của chính CS (Ethan chốt
  // ở preview v6) — tránh hiểu nhầm là một giọng chung của hệ thống.
  ["default", "Mặc định (theo profile CS)"],
  ["friendly", "Thân thiện"],
  ["formal", "Trang trọng"],
  ["concise", "Ngắn gọn"],
];

/**
 * Form soạn trong popup Draft: ý + giọng văn nằm TRƯỚC nút soạn — CS chọn
 * trước, draft sinh ra mới theo đúng lựa chọn (giữ nguyên tắc từ bản inline cũ).
 */
export function draftCompose({ onGenerate }) {
  const genBtn = actionButtonState(state.busyAction, "generate");
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
  return el("div", { className: "compose-form" }, [
    el("p", { className: "muted", textContent: "Ý của bạn (không bắt buộc)." }),
    hintBox,
    el("div", { className: "row draft-actions" }, [
      toneSelect,
      el("button", { className: "button-primary compose-button", disabled: genBtn.disabled, onclick: () => onGenerate(Boolean(state.draft)) }, buttonContent(genBtn.running, state.busy, state.draft ? "Soạn lại tin trả lời" : "Soạn tin trả lời")),
    ]),
  ]);
}

function draftModal(handlers) {
  // Cho soạn khi: có tin khách chờ (trả lời thường), đã có draft, HOẶC hội
  // thoại đã từng có tin khách — server tự đóng khung follow-up cho các case
  // không có tin chờ (Ethan chốt 2026-10-27: draft không được chặn chỉ vì
  // khách chưa nhắn thêm; ca điển hình là email khách đã nhận auto-reply).
  // Chỉ chặn khi hội thoại CHƯA TỪNG có tin khách nào.
  const followUpKeys = (state.check?.jira ?? []).filter((j) => j.has_update).map((j) => j.issue_key);
  const followUpOnly = !state.check?.needs_reply && !state.draft && followUpKeys.length > 0;
  const canCompose = Boolean(state.check?.needs_reply || state.draft || followUpKeys.length || state.check?.last_customer_at);
  return [
    state.progress?.action === "generate" ? handlers.progressCard() : null,
    !canCompose ? el("p", { className: "muted", textContent: "Chưa có tin khách đang chờ trong conversation này." }) : null,
    followUpOnly ? el("p", { className: "muted", textContent: `Ticket ${followUpKeys.join(", ")} · Cập nhật mới từ Dev` }) : null,
    canCompose && (state.composeOpen || !state.draft) ? draftCompose(handlers) : null,
    state.draft && !state.composeOpen ? el("button", { className: "button-secondary", textContent: "Soạn lại với ý / giọng khác", onclick: () => { state.composeOpen = true; handlers.rerender(); } }) : null,
    state.draft ? draftPanel(handlers) : null,
    state.choice && state.choiceFor === "draft" ? handlers.insertChoice() : null,
  ];
}

function noteModal(handlers) {
  const noteBtn = actionButtonState(state.busyAction, "handoff");
  return [
    state.progress?.action === "handoff" ? handlers.progressCard() : null,
    // Ô Note có chữ (not_empty): bộ nút Thay thế/Chèn/Huỷ phải hiện NGAY trong
    // popup như draft/review — render() ở app.js chỉ hiện insertChoice ngoài
    // popup khi không có popup nào mở, thiếu dòng này thì CS kẹt không thấy nút.
    state.choice && state.choiceFor === "note" ? handlers.insertChoice() : null,
    state.handoff ? handoffPanel(handlers) : el("div", { className: "compose-form" }, [
      el("button", { className: "button-primary", disabled: noteBtn.disabled, onclick: () => handlers.onHandoff(false) }, buttonContent(noteBtn.running, "Đang viết private note…", "Viết private note")),
    ]),
  ];
}

function askModal(handlers) {
  return [
    state.progress?.action === "ask" ? handlers.progressCard() : null,
    knowledgePanel(handlers),
  ];
}

/**
 * Trình sửa tin xin review trong popup CSAT: template nạp sẵn từ server
 * (check.review_template — giọng theo profile của CS, link theo workspace;
 * chưa học được thì mặc định có ghi nguồn), dự phòng cuối là REVIEW_TEMPLATE
 * ở core.js. CS sửa tự do rồi điền vào ô Reply qua extension như draft.
 */
function reviewEditor(handlers) {
  const ready = state.bridge === "ready";
  if (!state.reviewText) state.reviewText = state.check?.review_template?.text ?? REVIEW_TEMPLATE;
  const fromProfile = state.check?.review_template?.source === "profile";
  const area = el("textarea", {
    className: "field review-text",
    rows: 5,
    value: state.reviewText,
    oninput: (e) => {
      state.reviewText = e.target.value;
      state.reviewInsertId = "";
      // Sửa tay khác hẳn bản gốc lẫn bản gợi ý → thẻ gợi ý hết ngữ cảnh, về pha đầu.
      const t = state.check?.review_template;
      if (t?.suggestion && e.target.value !== t.text && e.target.value !== t.suggestion.text) state.reviewSuggPhase = "";
    },
  });
  return el("div", { className: "review-editor" }, [
    el("p", { className: "muted", textContent: fromProfile
      ? "Template theo profile của bạn."
      : "Template mặc định của workspace." }),
    area,
    suggestionCard("review", handlers),
    state.choice && state.choiceFor === "review" ? handlers.insertChoice() : null,
    state.choice && state.choiceFor === "review" ? null : el("button", { className: "button-primary", disabled: !ready || state.insertPending, textContent: "Điền vào ô Reply", onclick: () => handlers.sendReviewInsert("auto") }),
    !ready ? el("p", { className: "muted", textContent: "Cài extension để điền tin xin review thẳng vào ô Reply của Crisp." }) : null,
  ]);
}

function csatModal(handlers) {
  const choice = state.csatChoice;
  const opt = (key, title, desc) => el("button", {
    className: `opt${choice === key ? " on" : ""}`,
    onclick: () => { state.csatChoice = key; handlers.rerender(); },
  }, [
    el("span", {}, [
      el("b", { textContent: title }),
      el("span", { className: "muted opt-desc", textContent: desc }),
    ]),
  ]);
  return [
    opt("survey", "Gửi CSAT survey", "Khảo sát hài lòng qua Crisp, như luồng hiện tại."),
    opt("review", "Xin review bằng tin nhắn", "Điền template xin review vào ô Reply để gửi như tin thường."),
    choice === "survey" ? csatPanel(handlers) : null,
    choice === "review" ? reviewEditor(handlers) : null,
  ];
}

/**
 * Popup mẫu giải thích một finding Storefront: đoạn mẫu tĩnh theo loại lỗi
 * (explanationTemplate ở core.js, đã chèn sẵn trang/ngôn ngữ/text lỗi của
 * finding đang xét). Điền vào ô Reply bằng ĐÚNG cơ chế insert của draft/
 * review (extension, insert-only) — CS đọc lại, sửa nếu cần rồi tự bấm
 * Send trong Crisp; copilot không tự gửi, không có đường Crisp mới.
 */
function explainModal(handlers) {
  const ready = state.bridge === "ready";
  const f = state.explainFinding;
  const head = f ? [f.kind ?? f.title, f.locale, f.page].filter(Boolean).join(" · ") : "";
  return [
    head ? el("p", { className: "muted", textContent: head }) : null,
    el("p", { className: "explain-text", textContent: state.explainText }),
    state.choice && state.choiceFor === "explain" ? handlers.insertChoice() : null,
    state.choice && state.choiceFor === "explain" ? null : el("button", { className: "button-primary", disabled: !ready || state.insertPending, textContent: "Điền vào ô Reply", onclick: () => handlers.sendExplainInsert("auto") }),
    !ready ? el("p", { className: "muted", textContent: "Cài extension để điền mẫu giải thích thẳng vào ô Reply của Crisp." }) : null,
  ];
}

const MODAL_TITLES = {
  draft: "Draft — soạn tin trả lời",
  note: "Private note",
  ask: "Knowledge Base Asking",
  csat: "Xin CSAT / Review",
  explain: "Mẫu giải thích cho khách",
};

/**
 * Popup dùng chung: overlay + hộp thoại, đóng bằng nút Đóng, phím Esc (app.js
 * bắt) hoặc bấm ra ngoài hộp. Nội dung theo state.modal; tiến trình của action
 * tương ứng hiện ngay trong popup, kết quả cũng đỗ vào popup.
 */
export function modalView(handlers) {
  const m = state.modal;
  if (!m) return null;
  const bodies = { draft: draftModal, note: noteModal, ask: askModal, csat: csatModal, explain: explainModal };
  const modal = el("div", { className: "modal" }, [
    el("div", { className: "mhead" }, [
      el("b", { textContent: MODAL_TITLES[m] ?? "" }),
      el("button", { className: "button-secondary mclose", textContent: "Đóng ✕", onclick: () => handlers.onCloseModal() }),
    ]),
    ...bodies[m](handlers),
  ]);
  modal.setAttribute("role", "dialog");
  const overlay = el("div", { className: "overlay" }, [modal]);
  overlay.onclick = (e) => { if (e.target === overlay) handlers.onCloseModal(); };
  return overlay;
}
