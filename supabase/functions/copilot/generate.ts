import { sha256Hex } from "../_shared/auth.ts";
import { humanTranscript, inputFingerprint, latestCustomerQuery, unansweredCustomerMessages } from "../_shared/context.ts";
import type { Db } from "../_shared/db.ts";
import { type Ai, AiBadOutput, REWRITE_TEMPERATURE } from "../_shared/gemini.ts";
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
  stripEmDashes,
  VERIFY_SCHEMA,
  verifyPrompt,
} from "../_shared/prompts.ts";
import { enabledModules, jiraForConversation, jiraPromptBlock } from "../_shared/jira.ts";
import {
  mentionedInConversation,
  type StorefrontMcp,
  storefrontPromptBlock,
} from "../_shared/storefront.ts";
import { ensureEnglish } from "../_shared/translate.ts";
import type { Sentiment } from "../_shared/sentiment.ts";
import type { CaseMatch, ConversationRow, HelpdeskChunk, MessageRow, Warning, Workspace } from "../_shared/types.ts";
import { resolveSentiment } from "./analyze.ts";
import { loadConversation } from "./load.ts";
import { shopFromCustomData } from "./storefront-actions.ts";

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
  /** Luồng draft KHÔNG có gợi ý tối ưu (không thẻ gợi ý, không bước polish, để draft nhanh hơn một lượt gọi). Giữ field luôn null cho khớp shape response; cơ chế gợi ý vẫn sống ở template xin review. */
  draft_suggestion: { reason: string; text: string } | null;
}

type Deps = { db: Db; n8n: N8n; ai: Ai; storefront?: StorefrontMcp | null };

/**
 * Ngữ cảnh Storefront cho draft: finding của store thuộc CHÍNH conversation
 * này, và CHỈ những finding khớp nội dung hội thoại (kim page/text — cùng cơ
 * chế khớp với nhóm Đang xử lý) mới vào prompt, để CS soạn trả lời không
 * phải tự tra chéo sang module Storefront. Best-effort tuyệt đối: chưa cấu
 * hình MCP, cổng module chưa bật cho chat này, không có shop, hay MCP lỗi —
 * đều trả "" và draft vẫn soạn bình thường (ngữ cảnh phụ không được phép
 * làm gãy việc chính).
 */
async function storefrontContext(
  deps: Deps,
  ws: Workspace,
  websiteId: string,
  conv: ConversationRow,
  jiraItems: ReturnType<typeof jiraForConversation>,
  messages: MessageRow[],
): Promise<string> {
  try {
    if (!deps.storefront) return "";
    const shop = shopFromCustomData(conv);
    if (!shop) return "";
    const snapshot = await deps.db.getStorefrontStoreStatus(websiteId, shop).catch(() => null);
    const gate = { storefrontWatchEnabled: ws.storefront_watch, shopDomain: shop, snapshotWatched: snapshot ? snapshot.watched : null };
    if (!enabledModules(jiraItems, ws.jira_project, gate).storefront) return "";
    const findings = await deps.storefront.listFindings(websiteId, shop);
    if (!findings.length) return "";
    // Khớp trên toàn bộ tin hiển thị của hội thoại (khách + CS, không note,
    // không bot): khách mô tả đúng trang/text lỗi trong tin của họ cũng là
    // "liên quan" — không chỉ khi CS đã nhắc tới như nhóm Đang xử lý.
    const texts = messages.filter((m) => m.type === "text" && !m.is_bot).map((m) => m.content);
    return storefrontPromptBlock(findings.filter((f) => mentionedInConversation(f, texts)));
  } catch (e) {
    console.error("storefront context failed", e);
    return "";
  }
}

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
  req: { website_id: string; session_id: string; force: boolean; hint?: string; tone?: DraftTone; operator_name?: string },
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
        prompt_version: hit.prompt_version ?? "", sentiment: null, draft_suggestion: null,
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
    resolveSentiment(deps, req.website_id, req.session_id, messages, false, "generate"),
    deps.db.getVariants("draft"),
    deps.db.getJiraRows(req.website_id, req.session_id),
  ]);
  const { profile, source } = resolveProfile(profiles, topic, ws.default_profile, bestRow);
  // Tên trong draft phải theo ACCOUNT của CS đang dùng panel: widget gửi tên
  // account đọc từ SDK Crisp — nguồn này thắng dòng `operators` trong DB (bản
  // sao có thể cũ). Profile "best" mượn văn phong của đồng đội nên samples còn
  // nguyên tên người đó — khử tên người cho và gắn tên account vào prompt.
  const agentName = (req.operator_name ?? "").trim() || operator?.display_name?.trim() || null;
  let promptProfile = profile;
  if (source === "best" && bestRow && agentName && bestRow.crisp_user_id !== operatorId) {
    const donor = await deps.db.getOperator(bestRow.crisp_user_id).catch(() => null);
    if (donor?.display_name) promptProfile = rebindIdentity(profile, donor.display_name, agentName);
  }
  const variant = pickVariant(variants);
  const jiraItems = jiraForConversation(jiraRows, conv.last_human_operator_at);
  const jira = jiraPromptBlock(jiraItems);
  // Chế độ follow-up: không có tin khách chờ nhưng
  // ticket có cập nhật từ Dev chưa báo khách → draft là tin chủ động báo
  // lại theo đúng ngữ cảnh đó, prompt phải đóng khung khác hẳn trả lời tin
  // mới (không bịa câu hỏi của khách). Có tin chờ thì luôn là trả lời thường.
  const noPending = unansweredCustomerMessages(messages).length === 0;
  const followUpKeys = noPending ? jiraItems.filter((j) => j.has_update).map((j) => j.issue_key) : [];
  const followUpIssues = noPending ? (mood.sentiment?.issues ?? []).map((x) => x.summary).filter(Boolean) : [];
  const storefront = await storefrontContext(deps, ws, req.website_id, conv, jiraItems, messages);

  // Soạn lại (force): tăng biến thiên để bản mới khác thật, không hội tụ về
  // cùng một bản như lượt soạn thường (cùng lý do với handoff Viết lại).
  const { text, model } = await deps.ai.generate("draft", draftPrompt({
    profile: promptProfile,
    agentName,
    topicLabel: label(topic),
    transcript,
    helpdesk: found.helpdesk,
    cases: found.cases,
    variantNotes: variant.template_notes,
    jira,
    storefront,
    sentiment: mood.sentiment,
    hint,
    tone,
    // Không có tin chờ thì LUÔN đóng khung follow-up (kể cả khi không có
    // ticket cập nhật lẫn issue mở — không được chặn draft ở các case này;
    // prompt follow-up tự lùi về "vẫn còn việc mở trong
    // hội thoại" khi cả hai danh sách rỗng).
    followUp: noPending ? { issueKeys: followUpKeys, openIssues: followUpIssues } : undefined,
  }), { ...(req.force ? { temperature: REWRITE_TEMPERATURE } : {}) });
  // Gọt cơ học dấu gạch ngang dài trước mọi khâu sau:
  // bản lưu/cache/trả về đều là bản đã sạch dấu, khớp đúng chữ CS sẽ điền.
  const draft = stripEmDashes(text.trim());
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
    draft_suggestion: null,
  };
}
