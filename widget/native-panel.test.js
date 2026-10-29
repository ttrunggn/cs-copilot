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
const MODAL_SIZES = ["normal", "medium", "large", "wide"];

Deno.test("native-panel: version 1.0 và đúng 3 section Khách / Trạng thái / Action", () => {
  assertEquals(schema.version, "1.0");
  assertEquals(schema.sections.map((s) => s.id), ["khach", "trang_thai", "action"]);
  assertEquals(schema.sections.map((s) => s.title), ["Khách", "Trạng thái", "Action"]);
});

Deno.test("native-panel: mọi item id là duy nhất trên toàn schema", () => {
  const ids = schema.sections.flatMap((s) => s.items.map((i) => i.id));
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(ids, [
    "khach_tam_trang", "khach_tom_tat", "khach_van_de", "khach_tin_cho",
    "tt_csat", "tt_review", "tt_storefront", "tt_jira",
    "act_draft", "act_note", "act_kb", "act_csat", "act_review", "act_storefront", "act_jira",
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
        assert(MODAL_SIZES.includes(item.value.size), item.id);
      }
    }
  }
  const csat = schema.sections.find((s) => s.id === "action").items.find((i) => i.id === "act_csat");
  assertEquals(csat.value.type, "hook");
  assertEquals(csat.value.data.operator_email, "{operator.email}");
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
