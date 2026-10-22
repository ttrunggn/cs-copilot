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

export type NoteLanguage = "vi" | "en" | "mixed";
export type NoteLineStyle = "numbered" | "bullets" | "paragraphs";
export type NoteSectionField = "summary" | "issues" | "next_step";

export interface NoteSection {
  field: NoteSectionField;
  label: string; // nhãn CS tự dùng, "" = không in nhãn, nội dung đứng một mình
}

/**
 * Format private note học từ note cũ của từng CS (chỉ đặc điểm trình bày, không nội dung).
 * Chỉ áp ở lớp format (formatHandoffNote); nội dung vẫn do HANDOFF_SCHEMA quyết định.
 * sections thiếu trường nào thì trường đó được nối thêm bằng nhãn mặc định — không bao giờ bỏ nội dung.
 */
export interface NoteFormat {
  language: NoteLanguage;
  header: string | null; // dòng đầu, "{name}" thay bằng tên CS; null = CS không viết dòng đầu
  sections: NoteSection[]; // thứ tự + nhãn từng trường theo thói quen của CS
  line_style: NoteLineStyle; // cách liệt kê các vấn đề
  state_style: "emoji" | "text"; // trạng thái vấn đề: "✅ Xong" hay "Xong"
  sign_off: string | null; // dòng ký tên cuối note, "{name}" thay tên; null = không có
  notes_used: number; // số note đã dùng để học — bằng chứng, dưới ngưỡng thì không áp
}

export interface ProfileRow extends Partial<Profile> {
  crisp_user_id: string;
  website_id: string;
  topic: string;
  conversations_used: number;
  learned_at: string | null;
  manual_override: Partial<Profile> | null;
  note_format?: NoteFormat | null; // chỉ có ở dòng "_all" (cột jsonb, migration 20261022000016)
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
  updated_at: string | null; // lần cuối ingest/refresh chạm vào bản ghi, dùng đo độ tươi cho đường đọc nhanh
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
