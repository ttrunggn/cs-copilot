import type { Profile, ProfileRow } from "./types.ts";

export type ProfileSource = "topic" | "all" | "default";

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

/** Thứ tự: CS × topic → CS × _all → mặc định workspace. manual_override (_all rồi tới topic) luôn thắng. */
export function resolveProfile(
  rows: ProfileRow[],
  topic: string | null,
  workspaceDefault: Partial<Profile>,
): { profile: Profile; source: ProfileSource } {
  const byTopic = topic ? rows.find((r) => r.topic === topic) : undefined;
  const all = rows.find((r) => r.topic === "_all");
  const picked = byTopic ?? all;
  const source: ProfileSource = byTopic ? "topic" : all ? "all" : "default";

  const profile: Profile = {
    ...BUILTIN_PROFILE,
    ...defined(workspaceDefault),
    ...defined(picked),
    ...defined(all?.manual_override),
    ...defined(byTopic?.manual_override),
  };
  return { profile, source };
}
