import { assertEquals } from "jsr:@std/assert@1";
import { state } from "./state.js";

// Trạng thái khởi tạo = điểm bắt đầu của mọi chu trình loading/progress:
// chưa bận, chưa popup, chưa chờ điền, bridge đang kiểm tra. Nếu một default
// nào ở đây đổi (vd busyAction khác ""), mọi nút action sẽ sinh ra đã khoá.
Deno.test("state khởi tạo: không bận, không tiến trình, không popup, không chờ extension trả lời", () => {
  assertEquals(state.busy, "");
  assertEquals(state.busyAction, "");
  assertEquals(state.progress, null);
  assertEquals(state.abortController, null);
  assertEquals(state.modal, null);
  assertEquals(state.insertPending, false);
  assertEquals(state.bridge, "checking");
  assertEquals(state.check, null);
  assertEquals(state.draft, null);
  assertEquals(state.handoff, null);
  assertEquals(state.choice, false);
  assertEquals(state.unlinkConfirm, "");
  assertEquals(state.storefront, null);
  assertEquals(state.storefrontDetailLoading, "");
});
