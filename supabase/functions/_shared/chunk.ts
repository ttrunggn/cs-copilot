/** Cắt đoạn dài theo câu, câu vẫn dài thì cắt cứng, để mọi mảnh ≤ max. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max));
  }
  return out;
}

/**
 * Chia bài helpdesk thành các chunk để embed: tách theo đoạn trống, gom đoạn tới khi chạm maxChars.
 * Mỗi chunk bắt đầu bằng tiêu đề bài để chunk lẻ vẫn rõ ngữ cảnh.
 */
export function chunkMarkdown(title: string, md: string, maxChars = 1200): string[] {
  const pieces = md.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).flatMap((p) => splitLong(p, maxChars));
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + 2 + p.length > maxChars) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => `${title}\n\n${c}`);
}
