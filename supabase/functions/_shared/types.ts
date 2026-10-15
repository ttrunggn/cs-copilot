export interface MessageRow {
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
