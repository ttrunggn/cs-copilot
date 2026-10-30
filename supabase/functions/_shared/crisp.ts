// Client REST tối thiểu cho Crisp — CHỈ phục vụ HAI ngoại lệ ghi Ethan đã
// duyệt tường minh:
// (1) 2026-10-23: gắn/gỡ segment `storefront-watch` trên conversation để
//     các chat thuộc store đang có lỗi Storefront Watch tự nổi lên trong
//     inbox.
// (2) 2026-10-30: ghi DẢI cảm xúc vào custom data của conversation (key
//     `copilot_mood_band`) mỗi lần tính sentiment mới — để condition của
//     Generic Widget hiện đúng nút Tâm trạng màu theo dải (condition của
//     Crisp chỉ đọc dữ liệu Crisp, không đọc giá trị server fetch trả).
// Cả hai đều là ghi METADATA (không phải tin nhắn, không phải note, khách
// không nhìn thấy).
//
// TUYỆT ĐỐI không mở rộng client này ngoài hai ngoại lệ trên: không thêm
// method gửi message/note, không sửa field nào khác của meta, không đụng
// state/routing. CRISP WRITE RULE vẫn nguyên: copilot chỉ soạn draft/note
// để CS tự gửi trong Crisp; hai ngoại lệ này không phải tiền lệ nới thêm.
// (getConversationCustomData là thao tác ĐỌC meta thuần — không phải ghi,
// không thuộc diện cấm trên; Ethan duyệt 2026-10-26 cho đường tự resolve
// shopify_domain của Storefront.)
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

/** Key custom data giữ dải cảm xúc cho nút Tâm trạng của mặt native (Ethan duyệt 2026-10-30). Giá trị là một trong bốn màu nút của Crisp. */
export const MOOD_BAND_KEY = "copilot_mood_band";
export type MoodBand = "red" | "orange" | "black" | "green";

export class CrispError extends Error {}

export interface CrispClient {
  /** Segments hiện tại của conversation trên Crisp THẬT (meta.segments). */
  getConversationSegments(websiteId: string, sessionId: string): Promise<string[]>;
  /**
   * Custom data (meta.data) hiện tại của conversation trên Crisp THẬT —
   * thao tác ĐỌC thuần (không ghi gì): nguồn dự phòng để resolve
   * shopify_domain khi ingest chưa mang custom data về DB kịp (Ethan chốt
   * 2026-10-26: Storefront tự lấy domain, CS không nhập tay). null = Crisp
   * không có custom data cho phiên này.
   */
  getConversationCustomData(websiteId: string, sessionId: string): Promise<Record<string, unknown> | null>;
  /**
   * PATCH meta {segments} bằng danh sách ĐÃ MERGE sẵn. Client ghi nguyên
   * danh sách được đưa — không tự thêm/bớt phần tử nào; merge là việc của
   * caller (storefront-segments) sau khi đọc bản thật bằng
   * getConversationSegments.
   */
  setConversationSegments(websiteId: string, sessionId: string, segments: string[]): Promise<void>;
  /**
   * PATCH meta {data} bằng object custom data ĐÃ MERGE sẵn (ngoại lệ ghi
   * thứ hai, Ethan duyệt 2026-10-30 — chỉ cho key `copilot_mood_band`).
   * Client ghi nguyên object được đưa; merge là việc của caller
   * (copilot/mood-band.ts) sau khi đọc bản thật bằng
   * getConversationCustomData — PATCH data ghi đè cả trường data như
   * segments, không được ghi mỗi key của mình.
   */
  setConversationCustomData(websiteId: string, sessionId: string, data: Record<string, unknown>): Promise<void>;
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
    async setConversationCustomData(websiteId, sessionId, data) {
      await call("PATCH", websiteId, sessionId, { data });
    },
    async getConversationCustomData(websiteId, sessionId) {
      const data = await call("GET", websiteId, sessionId) as { data?: unknown } | null;
      const custom = data?.data;
      return custom && typeof custom === "object" && !Array.isArray(custom) ? custom as Record<string, unknown> : null;
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
