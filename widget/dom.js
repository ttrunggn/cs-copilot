// Helper DOM tối thiểu của widget: tạo element, thay nội dung panel, và báo
// chiều cao cho Crisp. Không chứa trạng thái hay logic nghiệp vụ.
export const app = document.getElementById("app");

export function fit() {
  try { window.$crisp?.setHeight?.(Math.min(document.body.scrollHeight + 8, 700)); } catch { /* ngoài Crisp */ }
}

export function el(tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c) n.append(c);
  return n;
}

export function show(...nodes) {
  app.replaceChildren(...nodes.filter(Boolean));
  fit();
}
