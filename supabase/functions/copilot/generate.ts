import { humanTranscript, inputFingerprint, latestCustomerQuery } from "../_shared/context.ts";
import type { Db } from "../_shared/db.ts";
import type { Ai } from "../_shared/gemini.ts";
import type { N8n } from "../_shared/n8n.ts";
import { type ProfileSource, resolveProfile } from "../_shared/profile.ts";
import {
  classifyPrompt,
  classifySchema,
  draftPrompt,
  parseTopic,
  parseWarnings,
  pickVariant,
  VERIFY_SCHEMA,
  verifyPrompt,
} from "../_shared/prompts.ts";
import { ensureEnglish } from "../_shared/translate.ts";
import type { CaseMatch, HelpdeskChunk, MessageRow, Warning, Workspace } from "../_shared/types.ts";
import { loadConversation } from "./load.ts";

export const HELPDESK_K = 5;
export const HELPDESK_MIN_SIMILARITY = 0.5;
export const CASES_K = 3;
export const CASES_MIN_SIMILARITY = 0.6;

export interface GenerateResult {
  action: "generate";
  stale: boolean;
  cached: boolean;
  output_id: number;
  draft: string;
  warnings: Warning[];
  verified: boolean;
  helpdesk_matches: number;
  topic: string | null;
  topic_label: string | null;
  profile_source: ProfileSource;
  prompt_version: string;
}

type Deps = { db: Db; n8n: N8n; ai: Ai };

/** Topic từ segment nếu có; chưa có thì AI phân loại và lưu lại. Lỗi thì bỏ qua (draft vẫn soạn được). */
async function resolveTopic(deps: Deps, ws: Workspace, websiteId: string, sessionId: string, current: string | null, transcript: string) {
  if (current || !ws.topics.length) return current;
  try {
    const { text } = await deps.ai.generate("classify", classifyPrompt(transcript, ws.topics), { schema: classifySchema(ws.topics) });
    const key = parseTopic(text, ws.topics);
    if (key) await deps.db.setAiTopic(websiteId, sessionId, key);
    return key;
  } catch (e) {
    console.error("classify failed", e);
    return null;
  }
}

/** Helpdesk + case tương tự theo câu hỏi gần nhất của khách. Embed lỗi thì soạn không có nguồn (ok = false). */
async function retrieve(deps: Deps, websiteId: string, messages: MessageRow[]) {
  try {
    const [vec] = await deps.ai.embed([latestCustomerQuery(messages)], "query");
    const [hd, cs] = await Promise.all([
      deps.db.matchHelpdesk(websiteId, vec, HELPDESK_K),
      deps.db.matchCases(websiteId, vec, CASES_K),
    ]);
    return {
      ok: true,
      helpdesk: hd.filter((c) => c.similarity >= HELPDESK_MIN_SIMILARITY),
      cases: cs.filter((c) => c.similarity >= CASES_MIN_SIMILARITY),
    };
  } catch (e) {
    console.error("retrieval failed", e);
    return { ok: false, helpdesk: [] as HelpdeskChunk[], cases: [] as CaseMatch[] };
  }
}

/** Đối chiếu draft với helpdesk. Lỗi gọi hoặc parse → chưa đối chiếu, không cảnh báo. */
async function verify(deps: Deps, draft: string, helpdesk: HelpdeskChunk[]): Promise<{ verified: boolean; warnings: Warning[] }> {
  try {
    const { text } = await deps.ai.generate("verify", verifyPrompt(draft, helpdesk), { schema: VERIFY_SCHEMA });
    return { verified: true, warnings: parseWarnings(text, helpdesk) };
  } catch (e) {
    console.error("verify failed", e);
    return { verified: false, warnings: [] };
  }
}

export async function runGenerate(
  req: { website_id: string; session_id: string; force: boolean },
  ws: Workspace,
  operatorId: string,
  deps: Deps,
): Promise<GenerateResult> {
  const { stale, conv, messages: raw } = await loadConversation(deps, req.website_id, req.session_id);
  const label = (key: string | null) => ws.topics.find((t) => t.key === key)?.label ?? null;
  const profiles = await deps.db.getProfiles(operatorId, req.website_id);
  const inputFp = await inputFingerprint("draft", operatorId, raw);

  if (!req.force) {
    const hit = await deps.db.findCachedOutput({
      websiteId: req.website_id, sessionId: req.session_id, operatorId, kind: "draft", inputFp,
    });
    if (hit) {
      return {
        action: "generate", stale, cached: true, output_id: hit.id, draft: hit.content, warnings: hit.warnings,
        verified: hit.verified ?? false, helpdesk_matches: hit.helpdesk_matches ?? 0, topic: hit.topic,
        topic_label: label(hit.topic), profile_source: resolveProfile(profiles, hit.topic, ws.default_profile).source,
        prompt_version: hit.prompt_version ?? "",
      };
    }
  }

  const messages = await ensureEnglish(raw, deps.ai, (rows) => deps.db.saveTranslations(rows));
  const transcript = humanTranscript(messages);
  const topic = await resolveTopic(deps, ws, req.website_id, req.session_id, conv.topic, transcript);
  const { profile, source } = resolveProfile(profiles, topic, ws.default_profile);
  const found = await retrieve(deps, req.website_id, messages);
  const variant = pickVariant(await deps.db.getVariants("draft"));

  const { text, model } = await deps.ai.generate("draft", draftPrompt({
    profile,
    topicLabel: label(topic),
    transcript,
    helpdesk: found.helpdesk,
    cases: found.cases,
    variantNotes: variant.template_notes,
  }));
  const draft = text.trim();
  // Không có bài helpdesk liên quan thì không có gì để đối chiếu; chỉ "chưa đối chiếu" khi tìm kiếm hoặc verify lỗi.
  const checked = found.helpdesk.length ? await verify(deps, draft, found.helpdesk) : { verified: found.ok, warnings: [] };

  const outputId = await deps.db.insertOutput({
    website_id: req.website_id,
    session_id: req.session_id,
    operator_id: operatorId,
    kind: "draft",
    input_fp: inputFp,
    content: draft,
    warnings: checked.warnings,
    verified: checked.verified,
    helpdesk_matches: found.helpdesk.length,
    topic,
    profile_used: source,
    model,
    prompt_version: variant.prompt_version,
  });
  return {
    action: "generate", stale, cached: false, output_id: outputId, draft, warnings: checked.warnings,
    verified: checked.verified, helpdesk_matches: found.helpdesk.length, topic, topic_label: label(topic),
    profile_source: source, prompt_version: variant.prompt_version,
  };
}
