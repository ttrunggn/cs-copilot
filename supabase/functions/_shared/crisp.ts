// Client REST tối thiểu cho Crisp — CHỈ phục vụ ngoại lệ ghi duy nhất Ethan
// đã duyệt tường minh (2026-10-23): gắn/gỡ segment `storefront-watch` trên
// conversation để các chat thuộc store đang có lỗi Storefront Watch tự nổi
// lên trong inbox. Đây là ghi METADATA (không phải tin nhắn, không phải
// note, khách không nhìn thấy) và là đường ghi Crisp DUY NHẤT của hệ thống.
//
// TUYỆT ĐỐI không mở rộng client này: không thêm method gửi message/note,
// không sửa field nào khác của meta, không đụng state/routing. CRISP WRITE
// RULE vẫn nguyên: copilot chỉ soạn draft/note để CS tự gửi trong Crisp;
// segment này là ngoại lệ đã chốt, không phải tiền lệ để nới thêm.
//
// Cơ chế theo tài liệu chính thức của Crisp (docs.crisp.chat, REST API V1 +
// báo cáo rà soát crisp-platform-mechanics-20261023-0913):
// - Base https://api.crisp.chat/v1, auth HTTP Basic BASE64(identifier:key)
//   của PLUGIN token kèm header `X-Crisp-Tier: plugin` (quota 5.000
//   req/ngày — job gắn segment phải tiết kiệm: chỉ gọi khi có diff).
// - Đọc meta: GET /website/{website_id}/conversation/{session_id}/meta
// - Ghi meta: PATCH cùng URL, body {segments: [...]} — scope yêu cầu
//   `website:conversation:sessions`. Segments là chuỗi tự do, không cần
//   đăng ký/tạo trước.
// - PATCH segments GHI ĐÈ cả trường segments, nên caller PHẢI đọc danh
//   sách hiện tại trên Crisp thật rồi MERGE (giữ mọi segment khác) trước
//   khi ghi — việc đó nằm ở copilot/storefront-segments.ts, client này chỉ
//   làm đúng 2 thao tác thô dưới đây.

export const CRISP_API_BASE = "https://api.crisp.chat/v1";
export const CRISP_TIMEOUT_MS = 10_000;

/** Segment duy nhất hệ thống được phép gắn/gỡ tự động (Ethan duyệt 2026-10-23). */
export const STOREFRONT_WATCH_SEGMENT = "storefront-watch";

export class CrispError extends Error {}

export interface CrispClient {
  /** Segments hiện tại của conversation trên Crisp THẬT (meta.segments). */
  getConversationSegments(websiteId: string, sessionId: string): Promise<string[]>;
  /**
   * PATCH meta {segments} bằng danh sách ĐÃ MERGE sẵn. Client ghi nguyên
   * danh sách được đưa — không tự thêm/bớt phần tử nào; merge là việc của
   * caller (storefront-segments) sau khi đọc bản thật bằng
   * getConversationSegments.
   */
  setConversationSegments(websiteId: string, sessionId: string, segments: string[]): Promise<void>;
}

export function createCrispClient(opts: {
  identifier: string;
  key: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): CrispClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CRISP_TIMEOUT_MS;
  const auth = `Basic ${btoa(`${opts.identifier}:${opts.key}`)}`;

  async function call(method: "GET" | "PATCH", websiteId: string, sessionId: string, body?: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${CRISP_API_BASE}/website/${websiteId}/conversation/${sessionId}/meta`, {
        method,
        headers: {
          "authorization": auth,
          "x-crisp-tier": "plugin",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const parsed = await res.json().catch(() => null) as { error?: unknown; data?: unknown } | null;
      if (!res.ok || parsed?.error === true) {
        throw new CrispError(`Crisp API ${method} meta lỗi (HTTP ${res.status})`);
      }
      return parsed?.data ?? null;
    } catch (e) {
      if (e instanceof CrispError) throw e;
      throw new CrispError(`Crisp API ${method} meta không gọi được: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getConversationSegments(websiteId, sessionId) {
      const data = await call("GET", websiteId, sessionId) as { segments?: unknown } | null;
      const segs = data?.segments;
      return Array.isArray(segs) ? segs.filter((s): s is string => typeof s === "string") : [];
    },
    async setConversationSegments(websiteId, sessionId, segments) {
      await call("PATCH", websiteId, sessionId, { segments });
    },
  };
}

/**
 * Dựng client từ env của function: CRISP_PLUGIN_IDENTIFIER +
 * CRISP_PLUGIN_KEY (plugin token tạo ở Crisp Marketplace, cần scope
 * website:conversation:sessions). Thiếu một trong hai → null và job gắn
 * segment trả trạng thái "unconfigured" trung thực — không gọi bừa bằng
 * credential nửa vời (cùng quy ước storefrontFromEnv).
 */
export function crispFromEnv(getEnv: (key: string) => string | undefined): CrispClient | null {
  const identifier = (getEnv("CRISP_PLUGIN_IDENTIFIER") ?? "").trim();
  const key = (getEnv("CRISP_PLUGIN_KEY") ?? "").trim();
  if (!identifier || !key) return null;
  return createCrispClient({ identifier, key });
}
