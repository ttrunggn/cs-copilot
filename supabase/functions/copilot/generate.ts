import { sha256Hex } from "../_shared/auth.ts";
import { humanTranscript, inputFingerprint, latestCustomerQuery } from "../_shared/context.ts";
import type { Db } from "../_shared/db.ts";
import { type Ai, AiBadOutput } from "../_shared/gemini.ts";
import type { N8n } from "../_shared/n8n.ts";
import { pickBestProfileRow, type ProfileSource, rebindIdentity, resolveProfile } from "../_shared/profile.ts";
import {
  classifyPrompt,
  classifySchema,
  type DraftTone,
  draftPrompt,
  parseTopic,
  parseWarnings,
  pickVariant,
  VERIFY_SCHEMA,
  verifyPrompt,
} from "../_shared/prompts.ts";
import { jiraForConversation, jiraPromptBlock } from "../_shared/jira.ts";
import { ensureEnglish } from "../_shared/translate.ts";
import type { Sentiment } from "../_shared/sentiment.ts";
import type { CaseMatch, HelpdeskChunk, MessageRow, Warning, Workspace } from "../_shared/types.ts";
import { resolveSentiment } from "./analyze.ts";
import { loadConversation } from "./load.ts";

export const HELPDESK_K = 5;
// Đo trên helpdesk Transcy: câu liên quan ≥ 0.70, câu lạc đề ~0.52.
export const HELPDESK_MIN_SIMILARITY = 0.65;
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
  /** Bài helpdesk thật sự đã đưa vào prompt (title + url) — badge "N ý có nguồn" đếm theo mảng này. Bản cache không lưu title nên trả []. */
  sources: { title: string; url: string }[];
  topic: string | null;
  topic_label: string | null;
  profile_source: ProfileSource;
  prompt_version: string;
  sentiment: Sentiment | null;
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
  req: { website_id: string; session_id: string; force: boolean; hint?: string; tone?: DraftTone },
  ws: Workspace,
  operatorId: string,
  deps: Deps,
): Promise<GenerateResult> {
  // Nạp hội thoại + profile + thông tin CS chạy song song: chúng không phụ thuộc
  // nhau, xếp hàng chờ từng cái chỉ cộng thêm độ trễ DB vào mỗi lần soạn.
  const [{ stale, conv, messages: raw }, profiles, allProfiles, operator] = await Promise.all([
    loadConversation(deps, req.website_id, req.session_id),
    deps.db.getProfiles(operatorId, req.website_id),
    deps.db.getWorkspaceAllProfiles(req.website_id),
    deps.db.getOperator(operatorId).catch(() => null),
  ]);
  const label = (key: string | null) => ws.topics.find((t) => t.key === key)?.label ?? null;
  // CS chưa có dữ liệu học → mặc định là bản học tốt nhất của team (không phải template cứng).
  const bestRow = pickBestProfileRow(allProfiles);
  const hint = (req.hint ?? "").trim();
  const tone: DraftTone = req.tone ?? "default";
  // Hint/giọng văn đổi thì draft phải khác: trộn vào dấu vân tay để cache không trả bản soạn không có ý của CS.
  const baseFp = await inputFingerprint("draft", operatorId, raw);
  const inputFp = hint || tone !== "default" ? await sha256Hex(`${baseFp}|hint:${hint}|tone:${tone}`) : baseFp;

  if (!req.force) {
    const hit = await deps.db.findCachedOutput({
      websiteId: req.website_id, sessionId: req.session_id, operatorId, kind: "draft", inputFp,
    });
    if (hit) {
      return {
        action: "generate", stale, cached: true, output_id: hit.id, draft: hit.content, warnings: hit.warnings,
        verified: hit.verified ?? false, helpdesk_matches: hit.helpdesk_matches ?? 0, sources: [], topic: hit.topic,
        topic_label: label(hit.topic), profile_source: resolveProfile(profiles, hit.topic, ws.default_profile, bestRow).source,
        prompt_version: hit.prompt_version ?? "", sentiment: null,
      };
    }
  }

  const messages = await ensureEnglish(raw, deps.ai, (rows) => deps.db.saveTranslations(rows));
  // Giữ reply text của bot trong context để CS không lặp lại hoặc phủ định điều khách vừa được thông báo.
  const transcript = humanTranscript(messages, 40, true);
  // Phân loại topic, tìm helpdesk/case, sentiment, variant và Jira độc lập nhau:
  // chạy tất cả song song thay vì nối tiếp để rút ngắn generate.
  const [topic, found, mood, variants, jiraRows] = await Promise.all([
    resolveTopic(deps, ws, req.website_id, req.session_id, conv.topic, transcript),
    retrieve(deps, req.website_id, messages),
    resolveSentiment(deps, req.website_id, req.session_id, messages),
    deps.db.getVariants("draft"),
    deps.db.getJiraRows(req.website_id, req.session_id),
  ]);
  const { profile, source } = resolveProfile(profiles, topic, ws.default_profile, bestRow);
  // Tên trong draft phải là của CS đang trực. Profile "best" mượn văn phong của
  // đồng đội nên samples còn nguyên tên người đó — khử tên người cho trước khi
  // đưa vào prompt, và gắn tên CS vào prompt để model không ký thay người khác.
  const agentName = operator?.display_name?.trim() || null;
  let promptProfile = profile;
  if (source === "best" && bestRow && agentName && bestRow.crisp_user_id !== operatorId) {
    const donor = await deps.db.getOperator(bestRow.crisp_user_id).catch(() => null);
    if (donor?.display_name) promptProfile = rebindIdentity(profile, donor.display_name, agentName);
  }
  const variant = pickVariant(variants);
  const jira = jiraPromptBlock(jiraForConversation(jiraRows, conv.last_human_operator_at));

  const { text, model } = await deps.ai.generate("draft", draftPrompt({
    profile: promptProfile,
    agentName,
    topicLabel: label(topic),
    transcript,
    helpdesk: found.helpdesk,
    cases: found.cases,
    variantNotes: variant.template_notes,
    jira,
    sentiment: mood.sentiment,
    hint,
    tone,
  }));
  const draft = text.trim();
  // Draft rỗng (bị chặn an toàn, model không trả gì) thì không lưu, không cache 24h.
  if (!draft) throw new AiBadOutput("draft rỗng");
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
    posted: null,
  });
  return {
    action: "generate", stale, cached: false, output_id: outputId, draft, warnings: checked.warnings,
    verified: checked.verified, helpdesk_matches: found.helpdesk.length,
    sources: found.helpdesk.map((c) => ({ title: c.title, url: c.url })), topic, topic_label: label(topic),
    profile_source: source, prompt_version: variant.prompt_version, sentiment: mood.sentiment,
  };
}
