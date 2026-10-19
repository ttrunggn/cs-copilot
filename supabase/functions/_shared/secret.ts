/** So sánh không phụ thuộc vị trí ký tự sai. Secret placeholder hoặc < 32 ký tự thì luôn từ chối. */
export function secretOk(got: string, secret: string): boolean {
  if (secret.startsWith("REPLACE_") || secret.length < 32) return false;
  let diff = got.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
  return diff === 0;
}
