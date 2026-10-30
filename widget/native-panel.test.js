import { assert, assertEquals } from "jsr:@std/assert@1";
import { openModalName, parseOpenParam } from "./core.js";

/**
 * Khoá schema mặt native (widget/native-panel.json) theo đúng giao thức
 * Crisp Generic Widget: Ethan dán nguyên file này vào cấu hình plugin —
 * sai một field là Crisp từ chối hoặc item câm. Mọi thay đổi schema phải
 * qua test này.
 */
const schema = JSON.parse(await Deno.readTextFile(new URL("./native-panel.json", import.meta.url)));

const BUTTON_COLORS = ["black", "blue", "green", "orange", "red", "purple"];
const BUTTON_TYPES = ["link", "modal", "hook", "submit"];
const MODAL_SIZES = ["normal", "medium", "large", "wide"]; // đúng enum reference Crisp: normal < medium < large < wide

Deno.test("native-panel: version 1.0 và đúng 6 section của panel GỘP — mỗi module một section gọn, dữ kiện đi cặp với nút (Ethan đính chính 30/10)", () => {
  assertEquals(schema.version, "1.0");
  assertEquals(schema.sections.map((s) => s.id), ["chatbot", "khach", "trang_thai", "storefront", "jira", "lenh"]);
  assertEquals(schema.sections.map((s) => s.title), ["Chatbot", "Khách", "Trạng thái", "Storefront", "Jira", "Lệnh"]);
});

Deno.test("native-panel: mọi item id là duy nhất trên toàn schema", () => {
  const ids = schema.sections.flatMap((s) => s.items.map((i) => i.id));
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(ids, [
    "bot_trang_thai", "bot_tra_loi", "bot_chan",
    "khach_tam_trang", "khach_tom_tat", "khach_van_de",
    "tt_csat", "act_csat", "tt_review", "act_review",
    "tt_storefront", "act_storefront",
    "tt_jira", "act_jira",
    "act_draft", "act_note", "act_kb",
  ]);
});

Deno.test("native-panel: data item đều fetch (value rỗng), không editable, immediate", () => {
  for (const s of schema.sections) {
    for (const item of s.items.filter((i) => i.type === "data")) {
      assertEquals(item.value.value, "", item.id);
      assertEquals(item.value.editable, false, item.id);
      assertEquals(item.value.immediate, true, item.id);
      assert(typeof item.value.label === "string" && item.value.label.length > 0, item.id);
    }
  }
});

Deno.test("native-panel: button hợp lệ — màu trong enum Crisp, modal có url + size, hook CSAT gắn email operator", () => {
  for (const s of schema.sections) {
    for (const item of s.items.filter((i) => i.type === "button")) {
      assert(BUTTON_TYPES.includes(item.value.type), item.id);
      assert(BUTTON_COLORS.includes(item.value.color), item.id);
      assert(typeof item.value.label === "string" && item.value.label.length > 0, item.id);
      if (item.value.type === "modal") {
        assert(item.value.url.startsWith("https://copilot-oe.netlify.app/?open="), item.id);
        assert(item.value.url.includes("session_id={conversation.session_id}"), item.id);
        assert(item.value.url.includes("fn=copilot-test"), item.id); // pha test: modal gọi function copilot-test, promote production thì bỏ
        assert(MODAL_SIZES.includes(item.value.size), item.id);
        assertEquals(item.value.size, "normal", item.id); // Ethan chốt 30/10 17:18: mọi modal dùng cỡ NHỎ NHẤT (Crisp không có mini; normal là nhỏ nhất)
      }
    }
  }
  const csat = schema.sections.find((s) => s.id === "trang_thai").items.find((i) => i.id === "act_csat");
  assertEquals(csat.value.type, "hook");
  assertEquals(csat.value.data.operator_email, "{operator.email}");
});

Deno.test("native-panel: KHÔNG còn nút Tâm trạng bấm phân tích lại (Ethan bỏ 30/10 16:26 — sentiment tự cập nhật nền) — section Khách chỉ còn 3 data: điểm, tóm tắt, vấn đề", () => {
  const khach = schema.sections.find((s) => s.id === "khach");
  assertEquals(khach.items.map((i) => i.id), ["khach_tam_trang", "khach_tom_tat", "khach_van_de"]);
  assert(khach.items.every((i) => i.type === "data"));
  const all = schema.sections.flatMap((s) => s.items);
  assert(!all.some((i) => i.id.startsWith("tam_")), "nút tam_* còn sót");
});

Deno.test("native-panel: panel gộp — Chatbot stub đủ mặt; mỗi module một section gọn với dữ kiện đi CẶP nút của nó (Storefront/Jira/CSAT/Review); Jira một dòng đếm, không slot ticket; đúng 8 data fetch; Private note màu orange (enum không có vàng)", () => {
  const chatbot = schema.sections.find((s) => s.id === "chatbot");
  for (const id of ["bot_tra_loi", "bot_chan"]) {
    assertEquals(chatbot.items.find((i) => i.id === id).value.type, "hook", id);
  }
  const sf = schema.sections.find((s) => s.id === "storefront");
  assertEquals(sf.items.map((i) => i.id), ["tt_storefront", "act_storefront"]);
  const jira = schema.sections.find((s) => s.id === "jira");
  assertEquals(jira.items.map((i) => i.id), ["tt_jira", "act_jira"]);
  const tt = schema.sections.find((s) => s.id === "trang_thai");
  assertEquals(tt.items.map((i) => i.id), ["tt_csat", "act_csat", "tt_review", "act_review"]);
  const all = schema.sections.flatMap((s) => s.items);
  assert(!all.some((i) => i.id.startsWith("jira_ticket")), "slot jira_ticket còn sót");
  assertEquals(all.filter((i) => i.type === "data").length, 8);
  const note = schema.sections.find((s) => s.id === "lenh").items.find((i) => i.id === "act_note");
  assertEquals(note.value.color, "orange");
});

Deno.test("open param: chỉ nhận 6 view hợp lệ, còn lại bỏ qua", () => {
  for (const v of ["draft", "note", "ask", "review", "storefront", "jira"]) {
    assertEquals(parseOpenParam(`?open=${v}&session_id=session_1`), v);
  }
  assertEquals(parseOpenParam("?open=csat"), null);
  assertEquals(parseOpenParam("?session_id=session_1"), null);
  assertEquals(parseOpenParam(""), null);
});

Deno.test("open param → modal: review vào modal csat; storefront/jira không có modal (cuộn tới card)", () => {
  assertEquals(openModalName("draft"), "draft");
  assertEquals(openModalName("note"), "note");
  assertEquals(openModalName("ask"), "ask");
  assertEquals(openModalName("review"), "csat");
  assertEquals(openModalName("storefront"), null);
  assertEquals(openModalName("jira"), null);
  assertEquals(openModalName("lạ"), null);
});
