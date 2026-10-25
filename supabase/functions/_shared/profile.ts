import { asNoteFormat } from "./learn.ts";
import type { NoteFormat, Profile, ProfileRow } from "./types.ts";

export type ProfileSource = "topic" | "all" | "best" | "default";

export const BUILTIN_PROFILE: Profile = {
  tone: "friendly, polite, concise",
  pronoun_self: "I",
  pronoun_customer: "you",
  use_emoji: false,
  signature: null,
  sample_messages: [],
  style_notes: null,
};

const FIELDS = Object.keys(BUILTIN_PROFILE) as (keyof Profile)[];

function defined(p: Partial<Profile> | null | undefined): Partial<Profile> {
  const out: Partial<Profile> = {};
  if (!p) return out;
  for (const k of FIELDS) {
    const v = p[k];
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function definedExcept(p: Partial<Profile> | null | undefined, omit: (keyof Profile)[]): Partial<Profile> {
  const out = defined(p);
  for (const k of omit) delete out[k];
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Đổi tên người cho (donor) thành tên CS đang trực trong signature + sample messages.
 * Profile "tốt nhất của team" mang theo tên của chủ nó trong câu tự giới thiệu ở
 * samples ("This is Raymond from…") — không đổi thì draft ký tên người khác.
 * Chỉ thay tên đầy đủ và tên gọi (token đầu), giữ nguyên văn phong.
 */
export function rebindIdentity(profile: Profile, fromName: string, toName: string): Profile {
  const from = fromName.trim();
  const to = toName.trim();
  if (!from || !to || from === to) return profile;
  const swap = (s: string): string => {
    let out = s.split(from).join(to);
    const f = from.split(/\s+/)[0];
    const t = to.split(/\s+/)[0];
    if (f && t && f !== t) out = out.replace(new RegExp(`\\b${escapeRegExp(f)}\\b(?![-\\w])`, "g"), t);
    return out;
  };
  return {
    ...profile,
    signature: profile.signature ? swap(profile.signature) : profile.signature,
    sample_messages: profile.sample_messages.map(swap),
  };
}

/** Ngưỡng để một profile được coi là "bản học tốt" đủlàm mặc định cho người chưa có dữ liệu. */
export const MIN_CONVS_FOR_DEFAULT = 5;

/**
 * Chọn dòng "_all" học tốt nhất trong workspace (nhiều hội thoại nhất, hoà thì mới học nhất).
 * Chỉ lấy phần đã học — manual_override là cài đặt riêng cho từng CS, không rò sang mặc định chung.
 */
/** Mốc học → epoch ms. KHÔNG so chuỗi ngày thô (bài học vụ spam Jira: đuôi ".000Z" và "+00:00" làm thứ tự chuỗi ≠ thứ tự thời gian). Không parse được/thiếu → 0 (cũ nhất). */
const learnedMs = (r: ProfileRow): number => {
  const t = Date.parse(r.learned_at ?? "");
  return Number.isNaN(t) ? 0 : t;
};

export function pickBestProfileRow(rows: ProfileRow[]): ProfileRow | null {
  const candidates = rows.filter((r) => r.topic === "_all" && (r.conversations_used ?? 0) >= MIN_CONVS_FOR_DEFAULT);
  candidates.sort((a, b) =>
    (b.conversations_used ?? 0) - (a.conversations_used ?? 0) ||
    learnedMs(b) - learnedMs(a)
  );
  return candidates[0] ?? null;
}

/** Format note học tốt nhất trong workspace: nhiều note đã học nhất (asNoteFormat tự chặn dưới ngưỡng). */
export function pickBestNoteFormat(rows: ProfileRow[]): NoteFormat | null {
  let best: NoteFormat | null = null;
  let bestConvs = -1;
  for (const r of rows) {
    if (r.topic !== "_all") continue;
    const fmt = asNoteFormat(r.note_format);
    if (!fmt) continue;
    if (!best || fmt.notes_used > best.notes_used ||
      (fmt.notes_used === best.notes_used && (r.conversations_used ?? 0) > bestConvs)) {
      best = fmt;
      bestConvs = r.conversations_used ?? 0;
    }
  }
  return best;
}

/**
 * Thứ tự: CS × topic → CS × _all → mặc định workspace → bản học tốt nhất của team → builtin.
 * "Bản tốt nhất" chỉ lấp chỗ trống cho CS chưa có dữ liệu học; manual_override (_all rồi tới topic) luôn thắng.
 */
export function resolveProfile(
  rows: ProfileRow[],
  topic: string | null,
  workspaceDefault: Partial<Profile>,
  bestRow: ProfileRow | null = null,
): { profile: Profile; source: ProfileSource } {
  const byTopic = topic ? rows.find((r) => r.topic === topic) : undefined;
  const all = rows.find((r) => r.topic === "_all");
  const picked = byTopic ?? all;
  const source: ProfileSource = byTopic ? "topic" : all ? "all" : bestRow ? "best" : "default";

  const profile: Profile = {
    ...BUILTIN_PROFILE,
    // Lớp "best" đóng góp văn phong, KHÔNG đóng góp chữ ký: signature là danh tính
    // của người cho, để lọt sang thì draft của CS khác sẽ ký tên thay họ.
    ...definedExcept(bestRow, ["signature"]),
    ...defined(workspaceDefault),
    ...defined(picked),
    ...defined(all?.manual_override),
    ...defined(byTopic?.manual_override),
  };
  return { profile, source };
}

/**
 * Format note học theo CS, chỉ nằm ở dòng "_all" (format là thói quen cá nhân, không theo topic).
 * manual_override.note_format (nếu người quản trị đặt tay trong jsonb) thắng bản học, như mọi trường khác.
 * null = chưa đủ note để học → handoff dùng template cố định.
 */
export function resolveNoteFormat(rows: ProfileRow[], bestFormat: NoteFormat | null = null): NoteFormat | null {
  const all = rows.find((r) => r.topic === "_all");
  if (all) {
    const manual = (all.manual_override as { note_format?: unknown } | null)?.note_format;
    const own = asNoteFormat(manual) ?? asNoteFormat(all.note_format);
    if (own) return own;
  }
  // Chưa có format của riêng mình → dùng format học tốt nhất của team; vẫn không có thì null (template cố định).
  return bestFormat;
}
