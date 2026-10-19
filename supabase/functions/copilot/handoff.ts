import { humanTranscript, inputFingerprint } from "../_shared/context.ts";
import type { Db } from "../_shared/db.ts";
import { type Ai, AiBadOutput } from "../_shared/gemini.ts";
import type { N8n } from "../_shared/n8n.ts";
import { formatHandoffNote, HANDOFF_SCHEMA, handoffPrompt, parseHandoff } from "../_shared/prompts.ts";
import { ensureEnglish } from "../_shared/translate.ts";
import type { Workspace } from "../_shared/types.ts";
import { loadConversation } from "./load.ts";

const TRANSCRIPT_LINES = 80;

export interface HandoffResult {
  action: "handoff";
  stale: boolean;
  cached: boolean;
  output_id: number;
  note: string;
  posted: boolean;
}

/** Note tiếng Việt liệt kê từng vấn đề của khách. Lưu outputs trước rồi mới đăng, để đăng lỗi vẫn copy được. */
export async function runHandoff(
  req: { website_id: string; session_id: string; force: boolean },
  ws: Workspace,
  operatorId: string,
  deps: { db: Db; n8n: N8n; ai: Ai },
): Promise<HandoffResult> {
  const { stale, conv, messages: raw } = await loadConversation(deps, req.website_id, req.session_id);
  const inputFp = await inputFingerprint("handoff", operatorId, raw);
  if (!req.force) {
    const hit = await deps.db.findCachedOutput({
      websiteId: req.website_id, sessionId: req.session_id, operatorId, kind: "handoff", inputFp,
    });
    if (hit) {
      // Lần trước đăng lỗi thì đăng lại note cũ, không báo "đã đăng" khi Crisp chưa có note.
      if (hit.posted) return { action: "handoff", stale, cached: true, output_id: hit.id, note: hit.content, posted: true };
      const posted = await deps.n8n.postNote(req.website_id, req.session_id, hit.content);
      await deps.db.markPosted(hit.id, posted);
      return { action: "handoff", stale, cached: true, output_id: hit.id, note: hit.content, posted };
    }
  }

  const messages = await ensureEnglish(raw, deps.ai, (rows) => deps.db.saveTranslations(rows));
  const topicLabel = ws.topics.find((t) => t.key === conv.topic)?.label ?? null;
  const { text, model } = await deps.ai.generate("handoff", handoffPrompt(humanTranscript(messages, TRANSCRIPT_LINES), topicLabel, ""), {
    schema: HANDOFF_SCHEMA,
  });
  let fields;
  try {
    fields = parseHandoff(text);
  } catch (e) {
    console.error("handoff output unreadable", e);
    throw new AiBadOutput("handoff không đọc được");
  }
  const operator = await deps.db.getOperator(operatorId);
  const note = formatHandoffNote(fields, operator?.display_name ?? operatorId);

  const outputId = await deps.db.insertOutput({
    website_id: req.website_id,
    session_id: req.session_id,
    operator_id: operatorId,
    kind: "handoff",
    input_fp: inputFp,
    content: note,
    warnings: [],
    verified: null,
    helpdesk_matches: null,
    topic: conv.topic,
    profile_used: null,
    model,
    prompt_version: null,
    posted: null,
  });
  const posted = await deps.n8n.postNote(req.website_id, req.session_id, note);
  await deps.db.markPosted(outputId, posted);
  return { action: "handoff", stale, cached: false, output_id: outputId, note, posted };
}
