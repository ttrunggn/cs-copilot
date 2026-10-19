# CS Copilot v5 — Plan 5a: Widget sidebar (check) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CS mở một chat Transcy trong Crisp và thấy ngay ở sidebar: số tin khách chưa trả lời, topic, profile đang dùng, mức độ "tươi" của dữ liệu. Token nhập một lần.

**Architecture:** Trang tĩnh (HTML + ES module) host trên Netlify, nhúng vào Crisp dưới dạng iFrame widget của plugin. Crisp gắn `website_id`, `session_id` vào URL iframe. Widget gọi Edge Function `copilot` (`action: "check"`) với header `x-copilot-token`. Logic thuần (đọc URL, map lỗi, dựng view model, định dạng thời gian) nằm trong `widget/core.js` để test bằng Deno. `widget/app.js` chỉ lo DOM, `localStorage` và SDK Crisp.

**Tech Stack:** HTML/CSS/JS thuần (không build step), Crisp Widget JS SDK `https://assets.crisp.chat/widget/javascripts/sdk.min.js`, Netlify (`_headers`), Deno test.

**Spec:** `docs/superpowers/specs/2026-10-15-cs-copilot-multi-workspace-design.md` (mục 6.1)

## Global Constraints

- Không gọi Crisp/Supabase trực tiếp, chỉ gọi Edge Function `https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot`.
- Token CS lưu trong `localStorage` key `copilot_token`. Mọi lần đọc/ghi bọc try/catch, không có storage thì hỏi lại token mỗi lần.
- Text hiển thị tiếng Việt. Nội dung tin khách render bằng `textContent`, không dùng `innerHTML`.
- Netlify `_headers`: `Content-Security-Policy: frame-ancestors https://app.crisp.chat`.
- Plan này chỉ có `check`. Nút Soạn tin, Handoff và extension chèn chữ thuộc Plan 2 và Plan 5 đầy đủ.

## Review Focus

1. **URL thiếu `session_id`** (mở widget ngoài trang conversation, hoặc plugin thiếu scope) → báo "Mở một conversation để dùng copilot", không gọi API. Test: Task 1 `missing session_id`.
2. **Token sai hoặc hết hiệu lực (401)** → hiện lại ô nhập token và xoá token cũ. Test: Task 1 `401 → needToken`.
3. **Conversation mới chưa có trong DB (404)** → báo "Chưa có dữ liệu, thử lại sau vài giây" kèm nút thử lại, không coi là lỗi hệ thống. Test: Task 1 `404 → retry`.
4. **`localStorage` bị chặn trong iframe** → vẫn dùng được trong phiên. Test: Task 2 kiểm tra thủ công (ghi chú trong bước smoke).
5. **Tin khách rất dài hoặc chứa HTML** → cắt 300 ký tự, hiển thị như text thường. Test: Task 1 `escapes and truncates`.

---

## File Structure

```
widget/
  index.html     # khung trang + nạp SDK Crisp + app.js
  style.css      # giao diện gọn, hợp sidebar 300px, theo dark/light của hệ thống
  core.js        # thuần: readContext, mapError, toViewModel, timeAgo
  app.js         # DOM + localStorage + fetch + $crisp.setHeight
  _headers       # Netlify: CSP frame-ancestors
  core.test.js   # Deno test cho core.js
```

---

### Task 1: `widget/core.js` (logic thuần)

**Files:**
- Create: `widget/core.js`
- Test: `widget/core.test.js`

**Interfaces:**
- Produces:
  - `readContext(search: string): { websiteId: string, sessionId: string } | { error: string }`
  - `mapError(status: number, body: { error?: string }): { kind: "needToken" | "forbidden" | "retry" | "fatal", message: string }`
  - `toViewModel(check: CheckResult, now: number): { header, stale, needsReply, unanswered: string[], meta: string[] }`
  - `timeAgo(iso: string | null, now: number): string`

- [ ] **Step 1: Viết test (fail)**

`widget/core.test.js`:

```js
import { assertEquals } from "jsr:@std/assert@1";
import { mapError, readContext, timeAgo, toViewModel } from "./core.js";

const NOW = Date.parse("2026-10-16T10:00:00Z");

Deno.test("reads website_id and session_id from Crisp iframe URL", () => {
  assertEquals(readContext("?website_id=f5733b35-0234&session_id=session_abc-1&locale=en"), { websiteId: "f5733b35-0234", sessionId: "session_abc-1" });
});

Deno.test("missing session_id asks to open a conversation", () => {
  assertEquals(readContext("?website_id=ws1"), { error: "Mở một conversation để dùng copilot" });
});

Deno.test("malformed ids are rejected", () => {
  assertEquals(readContext("?website_id=ws1&session_id=../x"), { error: "Mở một conversation để dùng copilot" });
});

Deno.test("401 → needToken", () => {
  assertEquals(mapError(401, { error: "Token không hợp lệ" }).kind, "needToken");
});

Deno.test("403 → forbidden with server message", () => {
  assertEquals(mapError(403, { error: "CS không thuộc workspace này" }), { kind: "forbidden", message: "CS không thuộc workspace này" });
});

Deno.test("404 → retry", () => {
  assertEquals(mapError(404, {}).kind, "retry");
});

Deno.test("500 / network → fatal", () => {
  assertEquals(mapError(500, {}).kind, "fatal");
  assertEquals(mapError(0, {}).kind, "fatal");
});

Deno.test("timeAgo formats minutes, hours, days", () => {
  assertEquals(timeAgo("2026-10-16T09:58:00Z", NOW), "2 phút trước");
  assertEquals(timeAgo("2026-10-16T07:00:00Z", NOW), "3 giờ trước");
  assertEquals(timeAgo("2026-10-14T10:00:00Z", NOW), "2 ngày trước");
  assertEquals(timeAgo("2026-10-16T09:59:50Z", NOW), "vừa xong");
  assertEquals(timeAgo(null, NOW), "—");
});

const CHECK = {
  action: "check", stale: false, workspace: "Transcy", topic: "billing", topic_label: "Billing",
  profile_source: "topic", profile_name: "Lan Nguyen", needs_reply: true,
  unanswered: ["a", "b", "c", "d"], last_customer_at: "2026-10-16T09:58:00Z", last_human_operator_at: null, jira: [],
};

Deno.test("view model shows last 3 unanswered, newest last", () => {
  const vm = toViewModel(CHECK, NOW);
  assertEquals(vm.needsReply, true);
  assertEquals(vm.unanswered, ["b", "c", "d"]);
  assertEquals(vm.header, "4 tin khách chưa trả lời");
});

Deno.test("view model meta lines", () => {
  assertEquals(toViewModel(CHECK, NOW).meta, [
    "Topic: Billing",
    "Giọng văn: Lan Nguyen (theo topic)",
    "Khách nhắn: 2 phút trước · CS trả lời: —",
  ]);
});

Deno.test("view model when nothing pending", () => {
  const vm = toViewModel({ ...CHECK, needs_reply: false, unanswered: [], topic: null, topic_label: null, profile_source: "default" }, NOW);
  assertEquals(vm.header, "Không có tin chờ trả lời");
  assertEquals(vm.meta[0], "Topic: chưa xác định");
  assertEquals(vm.meta[1], "Giọng văn: Lan Nguyen (mặc định workspace)");
});

Deno.test("escapes and truncates long customer messages", () => {
  const long = "<b>x</b>" + "y".repeat(400);
  const vm = toViewModel({ ...CHECK, unanswered: [long] }, NOW);
  assertEquals(vm.unanswered[0].length, 301);
  assertEquals(vm.unanswered[0].startsWith("<b>x</b>"), true); // render bằng textContent, không parse HTML
});

Deno.test("stale flag passes through", () => {
  assertEquals(toViewModel({ ...CHECK, stale: true }, NOW).stale, true);
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `deno test widget/core.test.js`
Expected: FAIL `Module not found ... core.js`.

- [ ] **Step 3: Viết `widget/core.js`**

```js
// Logic thuần của widget: không chạm DOM, không chạm mạng.
const SESSION_ID = /^session_[\w-]+$/;
const WEBSITE_ID = /^[\w-]+$/;
const OPEN_CONVERSATION = "Mở một conversation để dùng copilot";

export function readContext(search) {
  const q = new URLSearchParams(search);
  const websiteId = q.get("website_id") ?? "";
  const sessionId = q.get("session_id") ?? "";
  if (!WEBSITE_ID.test(websiteId) || !SESSION_ID.test(sessionId)) return { error: OPEN_CONVERSATION };
  return { websiteId, sessionId };
}

export function mapError(status, body) {
  const msg = body?.error;
  if (status === 401) return { kind: "needToken", message: msg ?? "Nhập token copilot của bạn" };
  if (status === 403) return { kind: "forbidden", message: msg ?? "Bạn chưa được cấp quyền ở workspace này" };
  if (status === 404) return { kind: "retry", message: "Chưa có dữ liệu conversation này, thử lại sau vài giây" };
  return { kind: "fatal", message: "Không kết nối được copilot, thử lại sau" };
}

export function timeAgo(iso, now) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

const SOURCE_LABEL = { topic: "theo topic", all: "chung", default: "mặc định workspace" };
const MAX_CHARS = 300;

export function toViewModel(check, now) {
  const count = check.unanswered.length;
  return {
    header: check.needs_reply ? `${count} tin khách chưa trả lời` : "Không có tin chờ trả lời",
    stale: check.stale,
    needsReply: check.needs_reply,
    unanswered: check.unanswered.slice(-3).map((t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + "…" : t)),
    meta: [
      `Topic: ${check.topic_label ?? check.topic ?? "chưa xác định"}`,
      `Giọng văn: ${check.profile_name} (${SOURCE_LABEL[check.profile_source] ?? check.profile_source})`,
      `Khách nhắn: ${timeAgo(check.last_customer_at, now)} · CS trả lời: ${timeAgo(check.last_human_operator_at, now)}`,
    ],
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `deno test widget/core.test.js`
Expected: `ok | 12 passed`.

- [ ] **Step 5: Thêm `widget` vào `deno task test`, commit**

`deno.json` → `"test": "deno test --allow-read supabase/functions/tests n8n widget"`

```bash
git add widget/core.js widget/core.test.js deno.json
git commit -m "feat(widget): pure core for check view"
```

---

### Task 2: Trang widget + Netlify

**Files:**
- Create: `widget/index.html`, `widget/style.css`, `widget/app.js`, `widget/_headers`

**Interfaces:**
- Consumes: `readContext`, `mapError`, `toViewModel` (Task 1). Edge Function `POST /functions/v1/copilot` body `{website_id, session_id, action:"check"}`, header `x-copilot-token`.

- [ ] **Step 1: `widget/_headers`**

```
/*
  Content-Security-Policy: frame-ancestors https://app.crisp.chat
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
```

- [ ] **Step 2: `widget/index.html`**

```html
<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CS Copilot</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://assets.crisp.chat/widget/javascripts/sdk.min.js"></script>
</head>
<body>
  <main id="app" aria-live="polite">
    <p class="muted">Đang tải…</p>
  </main>
  <template id="token-form">
    <form class="token">
      <label for="token-input">Token copilot</label>
      <input id="token-input" type="password" autocomplete="off" required placeholder="Dán token được cấp">
      <button type="submit">Lưu</button>
      <p class="hint"></p>
    </form>
  </template>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: `widget/style.css`**

```css
:root {
  --bg: #ffffff; --fg: #1d2330; --muted: #6b7385; --line: #e4e7ee;
  --accent: #2a6df4; --warn-bg: #fff4e5; --warn-fg: #8a4b00; --card: #f6f7fb;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #16181d; --fg: #e8eaf0; --muted: #9aa1b2; --line: #2a2e37; --accent: #6c9bff; --warn-bg: #3a2a12; --warn-fg: #ffcf8a; --card: #1f2229; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { padding: 12px; display: grid; gap: 10px; }
h2 { margin: 0; font-size: 14px; font-weight: 600; }
.muted, .hint { color: var(--muted); margin: 0; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--warn-bg); color: var(--warn-fg); font-size: 12px; }
.pending { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.pending li { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; }
.meta { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; color: var(--muted); }
.row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--fg); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.token { display: grid; gap: 6px; }
.token input { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
```

- [ ] **Step 4: `widget/app.js`**

```js
import { mapError, readContext, toViewModel } from "./core.js";

const API = "https://rbodkthyuiyfotewgxku.supabase.co/functions/v1/copilot";
const TOKEN_KEY = "copilot_token";
const app = document.getElementById("app");
let memoryToken = "";

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || memoryToken; } catch { return memoryToken; }
}
function setToken(t) {
  memoryToken = t;
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* chỉ giữ trong phiên */ }
}
function fit() {
  try { window.$crisp?.setHeight?.(Math.min(document.body.scrollHeight + 8, 350)); } catch { /* ngoài Crisp */ }
}
function el(tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) n.append(c);
  return n;
}
function show(...nodes) {
  app.replaceChildren(...nodes);
  fit();
}

function showToken(hint) {
  const form = document.getElementById("token-form").content.firstElementChild.cloneNode(true);
  form.querySelector(".hint").textContent = hint ?? "Token do người quản lý copilot cấp, chỉ nhập một lần.";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    setToken(form.querySelector("input").value.trim());
    load();
  });
  show(form);
  form.querySelector("input").focus();
}

function showMessage(text, retry) {
  show(el("p", { className: "muted", textContent: text }), ...(retry ? [el("button", { textContent: "Thử lại", onclick: load })] : []));
}

function render(check) {
  const vm = toViewModel(check, Date.now());
  const head = el("div", { className: "row" }, [
    el("h2", { textContent: vm.header }),
    el("button", { textContent: "↻", title: "Làm mới", onclick: load }),
  ]);
  const nodes = [head];
  if (vm.stale) nodes.push(el("span", { className: "badge", textContent: "Dữ liệu có thể chậm vài phút" }));
  if (vm.unanswered.length) {
    nodes.push(el("ul", { className: "pending" }, vm.unanswered.map((t) => el("li", { textContent: t }))));
  }
  nodes.push(el("ul", { className: "meta" }, vm.meta.map((t) => el("li", { textContent: t }))));
  show(...nodes);
}

async function load() {
  const ctx = readContext(location.search);
  if ("error" in ctx) return showMessage(ctx.error);
  const token = getToken();
  if (!token) return showToken();
  showMessage("Đang kiểm tra…");
  let res, body = {};
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-copilot-token": token },
      body: JSON.stringify({ website_id: ctx.websiteId, session_id: ctx.sessionId, action: "check" }),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    return showMessage(mapError(0, {}).message, true);
  }
  if (res.ok) return render(body);
  const err = mapError(res.status, body);
  if (err.kind === "needToken") { setToken(""); return showToken(err.message); }
  showMessage(err.message, err.kind !== "forbidden");
}

window.CRISP_READY_TRIGGER = fit;
load();
```

- [ ] **Step 5: Smoke local**

Run: `npx --yes serve widget -l 5173` rồi mở `http://localhost:5173/?website_id=f5733b35-0234-49e3-aca0-ed27b30b8ee1&session_id=<session thật>`.
Expected: hiện form token → dán token → hiện số tin chưa trả lời, topic, giọng văn. Mở bằng cửa sổ ẩn danh chặn cookie để kiểm tra luồng không có `localStorage` (Review Focus 4).

- [ ] **Step 6: Commit**

```bash
git add widget/
git commit -m "feat(widget): Crisp sidebar widget for check, Netlify-ready"
```

---

### Task 3: Deploy Netlify + gắn vào plugin Crisp

- [ ] **Step 1: Deploy**

Cách nhanh: [app.netlify.com/drop](https://app.netlify.com/drop) → kéo thả thư mục `widget/`. Hoặc CLI: `npx netlify-cli deploy --prod --dir widget` (cần `NETLIFY_AUTH_TOKEN`).
Expected: có URL dạng `https://<tên>.netlify.app`, mở `/index.html` thấy "Mở một conversation để dùng copilot".

- [ ] **Step 2: Gắn vào plugin**

Marketplace → plugin → Widgets: schema iFrame
```json
{ "version": "1.0", "url": "https://<tên>.netlify.app/index.html" }
```
Expected: mở một chat Transcy → sidebar hiện widget, nhập token, thấy kết quả `check`.
