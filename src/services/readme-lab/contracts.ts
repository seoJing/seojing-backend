// Versioned Lab contract. Offsets are zero-based UTF-16 [start, end) in block.text.
export type Facet = "role" | "method" | "result" | "basis";
export interface ReaderCheck {
  facet: Facet;
  trigger: string;
  sufficient: string;
  insufficient: string;
}
export interface ReaderCriterion {
  id: string;
  requirement_id: string;
  label: string;
  checks: ReaderCheck[];
}
export interface ReaderProfile {
  version: "reader-profile-v2";
  id: string;
  criteria: ReaderCriterion[];
}
export interface Unit {
  id: string;
  block_id: string;
  order: number;
  start: number;
  end: number;
  text: string;
  scope_id: string;
}
export interface Block {
  id: string;
  type: "heading" | "paragraph" | "list_item" | "table_row";
  level?: number;
  text: string;
  unit_ids: string[];
}
export interface ResumeDocument {
  doc_id: string;
  source_kind: "txt" | "md" | "pdf" | "docx";
  blocks: Block[];
  units: Unit[];
  warnings: string[];
  truncated: false;
}
export interface Requirement {
  id: string;
  kind: "duty" | "required" | "preferred" | "other";
  label: string;
  quote: string;
  start: number;
  end: number;
}
export interface JobPosting {
  source: "user_paste";
  text: string;
  requirements: Requirement[];
  warnings: string[];
  reader_profile?: ReaderProfile;
}
export interface Note {
  id: string;
  unit_id: string;
  span: { block_id: string; start: number; end: number };
  kind: "question" | "evidence" | "hold" | "observation" | "resolves";
  text: string;
  question_id?: string;
  evidence_unit_ids: string[];
  requirement_ids: string[];
  review_required: true;
}
export interface Question {
  id: string;
  unit_id: string;
  scope_id: string;
  text: string;
  status: "open" | "held" | "open_at_end" | "partial" | "resolved" | "reopened";
  candidate_unit_ids: string[];
  label?: string;
  facet?: Facet;
  criterion_id?: string;
  evidence_unit_ids?: string[];
  state_version?: number;
}
export type EventPayload =
  | {
      type: "window_started" | "window_completed";
      window_id: string;
      unit_ids: string[];
    }
  | { type: "note"; note: Note }
  | {
      type: "question_updated";
      question_id: string;
      previous_status: Question["status"] | null;
      status: Question["status"];
      evidence_unit_ids: string[];
      at_unit_id: string;
      state_version: number;
      question: Question;
    }
  | { type: "reading_completed" }
  | { type: "report_completed" }
  | { type: "failed"; error: string; partial: boolean }
  | { type: "cancelled" };
export type ReadingEvent = EventPayload & { seq: number };
export interface ReportItem {
  id: string;
  category: "explained" | "open" | "improve";
  text: string;
  reason: string;
  citations: Array<{
    unit_id: string;
    block_id: string;
    start: number;
    end: number;
  }>;
  note_ids: string[];
  requirement_ids: string[];
}
export interface Report {
  items: ReportItem[];
  questions: Question[];
  limitations: string[];
}
export interface LayaMetadata {
  model: string;
  revision: string;
  sdk: string;
  device: string;
  weights_sha256: string;
  finetuned: false;
  calibrated_for_readme: false;
}
export interface Generation {
  engine: "laya" | "jev";
  policy_version: "readme-prefix-v1" | "readme-prefix-v2";
  model:
    | LayaMetadata
    | {
        model: "jev-1.13.0";
        provider: "typesafe";
        execution: "remote";
        calibrated_for_readme: false;
      }
    | null;
  prepare_engine: "codex_cli";
  report_engine: "codex_cli";
  codex_model: string;
}
export interface PrepareView {
  prepare_id: string;
  input_hash: string;
  status:
    | "queued"
    | "extracting"
    | "analyzing_job"
    | "ready"
    | "failed"
    | "cancelled";
  document?: ResumeDocument;
  job?: JobPosting;
  error?: string;
  expires_at: string;
}
export interface JobView {
  job_id: string;
  status:
    | "queued"
    | "reading"
    | "reporting"
    | "completed"
    | "failed"
    | "cancelled";
  events: ReadingEvent[];
  next_seq: number;
  progress: {
    read_unit_count: number;
    total_unit_count: number;
    current_window: string | null;
  };
  report: Report | null;
  error: string | null;
  generation: Generation;
  expires_at: string;
}
