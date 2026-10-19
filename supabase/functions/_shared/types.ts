export interface MessageRow {
  id: number;
  content_en: string | null;
  from: "user" | "operator";
  type: string;
  is_bot: boolean;
  content: string;
  created_at: string;
  operator_name: string | null;
}

export interface Topic {
  key: string;
  label: string;
  definition?: string; // mô tả khi nào thuộc topic, giúp AI phân loại
  segments: string[];
}

export interface Profile {
  tone: string;
  pronoun_self: string;
  pronoun_customer: string;
  use_emoji: boolean;
  signature: string | null;
  sample_messages: string[];
  style_notes: string | null;
}

export interface Workspace {
  website_id: string;
  name: string;
  topics: Topic[];
  default_profile: Partial<Profile>;
}

export interface ProfileRow extends Partial<Profile> {
  crisp_user_id: string;
  website_id: string;
  topic: string;
  conversations_used: number;
  learned_at: string | null;
  manual_override: Partial<Profile> | null;
}

export interface ConversationRow {
  website_id: string;
  session_id: string;
  customer_email: string | null;
  customer_name: string | null;
  topic: string | null;
  topic_source: "segment" | "ai" | null;
  state: string | null;
  last_customer_at: string | null;
  last_human_operator_at: string | null;
}

export interface HelpdeskChunk {
  title: string;
  url: string;
  text: string;
  similarity: number;
}

export interface CaseMatch {
  summary: string;
  resolution: string | null;
  final_reply: string | null;
  similarity: number;
}

export interface Variant {
  prompt_version: string;
  template_notes: string | null;
  weight: number;
}

export interface Warning {
  claim: string;
  reason: string;
  article_url: string | null;
}

export type HandoffState = "done" | "in_progress" | "waiting_customer" | "waiting_tech" | "not_started";
export type WaitingOn = "customer" | "tech" | "cs" | "none";

export interface HandoffIssue {
  issue: string;
  state: HandoffState;
  detail: string;
}

export interface HandoffFields {
  summary: string;
  issues: HandoffIssue[];
  more?: number; // số vấn đề bị lược bớt khi quá MAX_ISSUES
  waiting_on: WaitingOn;
  next_step: string;
}

export interface OutputRow {
  id: number;
  kind: "draft" | "handoff";
  content: string;
  warnings: Warning[];
  verified: boolean | null;
  helpdesk_matches: number | null;
  topic: string | null;
  prompt_version: string | null;
  posted: boolean | null; // chỉ handoff: note đã lên Crisp chưa
  created_at: string;
}

export type NewOutput = Omit<OutputRow, "id" | "created_at"> & {
  website_id: string;
  session_id: string;
  operator_id: string;
  input_fp: string;
  profile_used: string | null;
  model: string | null;
};
