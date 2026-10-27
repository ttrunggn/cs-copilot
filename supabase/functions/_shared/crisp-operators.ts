// Client gửi email tới operator qua Crisp REST — phục vụ DUY NHẤT email
// digest Storefront Watch (Ethan duyệt 2026-10-27: "làm đi, gửi về email
// operator"). Đây là kênh THÔNG BÁO NỘI BỘ tới operator của workspace,
// không phải tin nhắn/note cho khách — không thuộc đường ghi conversation
// mà CRISP WRITE RULE cấm. Client segment trong _shared/crisp.ts giữ
// nguyên vẹn, không liên quan file này; không mở rộng file này sang bất
// kỳ loại gửi nào khác.
//
// API chính thức (docs.crisp.chat, REST API V1 — kiểm chứng 2026-10-27):
// - POST https://api.crisp.chat/v1/website/{website_id}/operators/email
// - Tier plugin, scope yêu cầu: website:operators.
// - Body: recipient ("all" | "owners" | "members" | "user"; user cần
//   thêm user_id), subject, message; target {label, url} là nút bấm tuỳ
//   chọn — digest KHÔNG dùng (Ethan chốt format email tối giản).
// - Auth HTTP Basic BASE64(identifier:key) của plugin token + header
//   X-Crisp-Tier: plugin, cùng credential với client segment.
// Token plugin hiện có scope website:operators hay chưa chỉ biết ở lần
// gọi thật đầu tiên (Crisp trả lỗi scope) — caller phải báo trung thực
// trạng thái đó thay vì nuốt lỗi.

import { CRISP_API_BASE, CRISP_TIMEOUT_MS, CrispError } from "./crisp.ts";

export interface OperatorMailer {
  /** Gửi email tới TOÀN BỘ operator của workspace (recipient "all"). */
  sendOperatorEmail(websiteId: string, input: { subject: string; message: string }): Promise<void>;
}

export function createOperatorMailer(opts: {
  identifier: string;
  key: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): OperatorMailer {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CRISP_TIMEOUT_MS;
  const auth = `Basic ${btoa(`${opts.identifier}:${opts.key}`)}`;

  return {
    async sendOperatorEmail(websiteId, input) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doFetch(`${CRISP_API_BASE}/website/${websiteId}/operators/email`, {
          method: "POST",
          headers: {
            "authorization": auth,
            "x-crisp-tier": "plugin",
            "content-type": "application/json",
          },
          body: JSON.stringify({ recipient: "all", subject: input.subject, message: input.message }),
          signal: ctrl.signal,
        });
        const parsed = await res.json().catch(() => null) as { error?: unknown } | null;
        if (!res.ok || parsed?.error === true) {
          throw new CrispError(`Crisp API POST operators/email lỗi (HTTP ${res.status})`);
        }
      } catch (e) {
        if (e instanceof CrispError) throw e;
        throw new CrispError(`Crisp API POST operators/email không gọi được: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Dựng mailer từ env của function: dùng chung CRISP_PLUGIN_IDENTIFIER +
 * CRISP_PLUGIN_KEY với client segment. Thiếu một trong hai → null và job
 * digest trả trạng thái "mail_unconfigured" trung thực.
 */
export function operatorMailerFromEnv(getEnv: (key: string) => string | undefined): OperatorMailer | null {
  const identifier = (getEnv("CRISP_PLUGIN_IDENTIFIER") ?? "").trim();
  const key = (getEnv("CRISP_PLUGIN_KEY") ?? "").trim();
  if (!identifier || !key) return null;
  return createOperatorMailer({ identifier, key });
}
