import { MOOD_BAND_KEY, type CrispClient, type MoodBand } from "../_shared/crisp.ts";

/**
 * Đồng bộ DẢI cảm xúc lên custom data của conversation trên Crisp —
 * ngoại lệ ghi thứ hai Ethan duyệt tường minh (2026-10-30), chỉ phục vụ
 * mặt native "Support Operation": condition của Crisp Generic Widget chỉ
 * đọc được dữ liệu của Crisp (conversation.meta.data.*), KHÔNG đọc được
 * giá trị server trả về khi fetch data item. Muốn nút Tâm trạng đổi màu
 * theo dải điểm thì dải phải nằm trong custom data của conversation.
 *
 * Ngưỡng dải theo đúng bản thiết kế Ethan duyệt (điểm mẫu trên board:
 * 12 đỏ · 38 cam · 61 đen · 86 xanh lá):
 *   < 25 red ("Rất bực") · 25–49 orange ("Đang bực") ·
 *   50–74 black ("Bình thường") · ≥ 75 green ("Hài lòng")
 *
 * Kỷ luật như đường segment (storefront-segments.ts): đọc bản THẬT trên
 * Crisp trước, chỉ PATCH khi dải đổi, PATCH object custom data ĐÃ MERGE
 * (giữ mọi key khác của conversation — PATCH data ghi đè cả trường).
 * Lỗi Crisp KHÔNG bao giờ làm gãy luồng sentiment: hàm này nuốt lỗi và
 * trả trạng thái để caller ghi trace.
 */

export function moodBandForScore(score: number): MoodBand {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  if (s < 25) return "red";
  if (s < 50) return "orange";
  if (s < 75) return "black";
  return "green";
}

export type MoodBandSyncResult =
  | { status: "updated"; band: MoodBand }
  | { status: "unchanged"; band: MoodBand }
  | { status: "unconfigured" }
  | { status: "failed"; band: MoodBand; error: string };

export async function syncMoodBand(
  deps: { crisp?: CrispClient | null },
  websiteId: string,
  sessionId: string,
  score: number,
): Promise<MoodBandSyncResult> {
  const band = moodBandForScore(score);
  if (!deps.crisp) return { status: "unconfigured" };
  try {
    const current = await deps.crisp.getConversationCustomData(websiteId, sessionId);
    if (current?.[MOOD_BAND_KEY] === band) return { status: "unchanged", band };
    await deps.crisp.setConversationCustomData(websiteId, sessionId, { ...(current ?? {}), [MOOD_BAND_KEY]: band });
    return { status: "updated", band };
  } catch (e) {
    return { status: "failed", band, error: e instanceof Error ? e.message : String(e) };
  }
}
