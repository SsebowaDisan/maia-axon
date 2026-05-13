export type SearchMode =
  | "library"
  | "deep_search"
  | "standard"
  | "google_analytics"
  | "google_ads"
  | "learn";

export type StreamingStatus = "idle" | "retrieving" | "reasoning" | "calculating" | "done";

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
}

export interface AuthTokenResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
  document_count: number;
  user_count: number;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  conversation_count: number;
}

export interface Company {
  id: string;
  name: string;
  ga4_property_id: string | null;
  google_ads_customer_id: string | null;
  google_ads_login_customer_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyUserAssignment {
  id: string;
  company_id: string;
  user_id: string;
  assigned_by: string;
  assigned_at: string;
}

export interface ExportDestination {
  id: string;
  user_id: string;
  company_id: string | null;
  type: "google_doc" | "google_sheet";
  title: string;
  url: string;
  file_id: string;
  status: string;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExportDestinationInfo {
  service_account_email: string;
}

export interface ExportWriteResponse {
  destination_id: string;
  destination_type: "google_doc" | "google_sheet";
  title: string;
  status: string;
  written_at: string;
}

export interface GroupAssignment {
  group_id: string;
  user_id: string;
  assigned_by: string;
  assigned_at: string;
}

export interface Document {
  id: string;
  group_id: string;
  filename: string;
  file_url: string;
  file_size_bytes: number | null;
  page_count: number | null;
  status: DocumentStatusValue;
  current_stage: DocumentStatusValue | null;
  progress_current: number | null;
  progress_total: number | null;
  error_detail: string | null;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
  // 0 until the section-mapping pipeline has run; the library card
  // surfaces a "Mindmap" badge when this is > 0.
  section_count?: number;
}

export type DocumentStatusValue =
  | "uploading"
  | "splitting"
  | "glm_ocr"
  | "captioning"
  | "embedding"
  | "ready"
  | "failed";

export interface DocumentStatus {
  id: string;
  status: DocumentStatusValue;
  current_stage: DocumentStatusValue | null;
  progress_current: number | null;
  progress_total: number | null;
  page_count: number | null;
  error_detail: string | null;
}

export interface DocumentUploadInitResponse {
  strategy: "direct_gcs" | "proxy";
  document: Document | null;
  upload_url: string | null;
}

export interface PageRegion {
  type?: string;
  glm_label?: string;
  bbox?: number[];
  content?: string;
  target_page_number?: number;
  target_page_label?: number;
  target_title?: string;
  nav_entry_kind?: "page" | "section" | string;
  latex?: string;
  variables?: Record<string, string>;
  caption?: string;
  description?: string;
  content_markdown?: string;
  headers?: string[];
  rows?: string[][];
}

export interface PageData {
  id: string;
  document_id: string;
  page_number: number;
  printed_page_label: number | null;
  image_url: string;
  page_width: number | null;
  page_height: number | null;
  markdown: string | null;
  ocr_text: string | null;
  ocr_confidence: number | null;
  regions: PageRegion[] | Record<string, unknown> | null;
}

export interface Citation {
  id: string;
  source_type: "pdf" | "web";
  document_id: string | null;
  document_name: string;
  page: number;
  boxes?: number[][] | null;
  snippet: string;
  url: string | null;
  title: string | null;
}

export interface MindmapNode {
  id: string;
  label: string;
  node_type: "answer" | "pdf_source" | "web_source" | "user_input" | "model_reasoning";
  source?: Citation;
  children: MindmapNode[];
}

export interface MessageVisualizationSeries {
  key: string;
  label: string;
  color?: string | null;
}

export interface MessageVisualization {
  type: "line" | "bar" | "stacked_bar" | "area" | "pie" | "table";
  title: string;
  subtitle?: string | null;
  x_key?: string | null;
  series?: MessageVisualizationSeries[];
  rows: Record<string, string | number | null>[];
  meta?: Record<string, string | number | null> | null;
}

export interface MessageResponse {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  citations: { citations?: Citation[] } | null;
  visualizations: MessageVisualization[] | null;
  mindmap: MindmapNode | null;
  suggested_questions: string[] | null;
  search_mode: SearchMode | null;
  created_at: string;
}

export interface ConversationSummary {
  id: string;
  user_id: string;
  project_id: string | null;
  group_id: string | null;
  title: string | null;
  title_icon: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: MessageResponse[];
}

export interface PassageContext {
  documentId: string | null;
  documentName: string | null;
  pageNumber: number;
  text: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: PromptAttachment[];
  // Optional inline-quoted passage the user attached via the PDF
  // viewer's "Ask Maia" action. Rendered as a card above the message
  // text so the user's question reads cleanly without markdown noise.
  passageContext?: PassageContext;
  createdAt: string;
  citations: Citation[];
  visualizations: MessageVisualization[];
  mindmap: MindmapNode | null;
  warnings: string[];
  searchMode: SearchMode;
  isStreaming: boolean;
  status: StreamingStatus;
  needsClarification: boolean;
  // Up to 5 follow-up questions in the user's language, generated by the
  // answer model from topics the corpus actually covers. Rendered as
  // clickable chips below the assistant bubble so Library mode acts as a
  // guided learning interface rather than a one-shot Q&A endpoint.
  suggestedQuestions?: string[];
}

export interface PromptAttachment {
  id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
}

export type MessageFeedbackRating = "up" | "down";
export type FeatureIdeaPriority = "nice_to_have" | "important" | "blocking";
export type FeatureIdeaStatus = "new" | "reviewed" | "planned" | "done";

export interface MessageFeedback {
  id: string;
  message_id: string;
  conversation_id: string;
  user_id: string;
  rating: MessageFeedbackRating;
  tags: string[] | null;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminMessageFeedback extends MessageFeedback {
  user_name: string;
  user_email: string;
  message_content: string;
  conversation_title: string | null;
}

export interface FeatureIdea {
  id: string;
  user_id: string;
  category: string;
  title: string | null;
  description: string;
  priority: FeatureIdeaPriority;
  status: FeatureIdeaStatus;
  created_at: string;
  updated_at: string;
}

export interface AdminFeatureIdea extends FeatureIdea {
  user_name: string;
  user_email: string;
}

export interface ChatQueryPayload {
  type: "query";
  project_id: string | null;
  group_id: string | null;
  company_id: string | null;
  document_ids: string[];
  attachment_ids: string[];
  include_dashboard?: boolean;
  mode: SearchMode;
  message: string;
  conversation_id: string | null;
}

export type WsServerEvent =
  | { type: "status"; status: Exclude<StreamingStatus, "idle" | "done"> }
  | { type: "token"; content: string }
  | { type: "citations"; data: Citation[] }
  | { type: "visualizations"; data: MessageVisualization[] }
  | { type: "mindmap"; data: MindmapNode }
  | { type: "warnings"; data: string[] }
  | {
      type: "done";
      conversation_id: string;
      suggested_questions?: string[] | null;
      // Set by the WS server when learn mode was requested but no
      // active path exists for the document — the frontend pops the
      // Start learning dialog.
      needs_diagnostic?: boolean;
    }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Learn mode
// ---------------------------------------------------------------------------

export type LearnDepth = "quick" | "normal" | "deep";

export type LearnPathStatus = "active" | "paused" | "completed" | "stale";

export interface LearnPathStep {
  section_id: string;
  title: string;
  rationale: string;
  page_start: number;
  page_end: number;
  is_target: boolean;
  is_prereq: boolean;
  status: "pending" | "in_progress" | "completed" | "skipped";
  completed_at: string | null;
  mastery_delta_json: Record<string, { previous: number; new: number }> | null;
}

export interface LearnPath {
  id: string;
  document_id: string;
  user_id: string;
  status: LearnPathStatus;
  goal_text: string;
  depth: LearnDepth;
  plan: LearnPathStep[];
  current_step: number;
  recompute_count: number;
  started_at: string;
  last_active_at: string;
  completed_at: string | null;
}

export type CheckInQuestionType =
  | "mcq"
  | "numeric"
  | "symbolic"
  | "free_text"
  | "counterexample"
  | "code";

export interface CheckInChoice {
  label: string;
  text: string;
}

export interface CheckInQuestion {
  id: string;
  section_id: string;
  question_type: CheckInQuestionType;
  stem: string;
  payload: {
    choices?: CheckInChoice[];
    units?: string | null;
    tolerance?: number | null;
    variables?: string[];
    [key: string]: unknown;
  };
  difficulty: number;
  estimated_seconds: number;
  display_ordinal: number;
}

export interface MasteryUpdate {
  concept_id: string;
  previous_score: number;
  new_score: number;
  is_known_now: boolean;
  became_known: boolean;
  became_unknown: boolean;
}

export interface CheckInResult {
  is_correct: boolean;
  score: number;
  feedback: string;
  explanation: string;
  misconception_tag: string | null;
  mastery_updates: MasteryUpdate[];
  section_completed: boolean;
}

export interface MindmapSectionNode {
  id: string;
  kind: "topic" | "subtopic" | "headline";
  title: string;
  page_start: number;
  page_end: number;
  ordinal: number;
  summary: string | null;
  concept_ids: string[];
  mastery_score: number | null;
  children: MindmapSectionNode[];
}

// ---------------------------------------------------------------------------
// Admin learn-mode review surface
// ---------------------------------------------------------------------------

export interface AdminLearnDocumentRow {
  id: string;
  filename: string;
  page_count: number | null;
  section_count: number;
  flagged_section_count: number;
  question_count: number;
  updated_at: string;
}

export interface AdminLearnSectionSummary {
  id: string;
  parent_id: string | null;
  kind: "topic" | "subtopic" | "headline";
  title: string;
  page_start: number;
  page_end: number;
  ordinal: number;
  review_flags: string[];
  has_questions: boolean;
}

export interface AdminLearnSectionDetail {
  id: string;
  document_id: string;
  parent_id: string | null;
  kind: "topic" | "subtopic" | "headline";
  title: string;
  page_start: number;
  page_end: number;
  ordinal: number;
  content_json: Record<string, unknown> | null;
  question_count: number;
}

export interface AdminLearnQuestionRow {
  id: string;
  section_id: string;
  question_type: CheckInQuestionType;
  stem: string;
  payload: Record<string, unknown>;
  explanation: string;
  concept_ids: string[];
  difficulty: number;
  estimated_seconds: number;
  misconception_tags: string[];
  display_ordinal: number;
  review_meta: { source_quote?: string; confidence?: number; leakage_flag?: boolean } | null;
}

export interface AdminLearnConceptRow {
  id: string;
  canonical_name: string;
  canonical_definition: string;
  aliases: string[] | null;
  difficulty_tier: number | null;
  introduction_count: number;
  application_count: number;
}

export interface UploadProgressState {
  fileName: string;
  progress: number;
  status: "uploading" | "processing" | "done" | "failed";
  documentId?: string;
  error?: string;
}

export type AdminTab = "groups" | "documents" | "users";

export interface WelcomePayload {
  intro_markdown: string;
  suggested_questions: string[];
}

export type AnnotationVisibility = "private" | "group_shared";
export type AnnotationColor = "yellow" | "green" | "blue" | "pink" | "orange";

export interface Annotation {
  id: string;
  document_id: string;
  page_number: number;
  color: AnnotationColor;
  highlighted_text: string;
  comment: string | null;
  visibility: AnnotationVisibility;
  char_start: number | null;
  char_end: number | null;
  // Each box is [x1, y1, x2, y2] in PDF native coordinates.
  boxes: number[][];
  user_id: string;
  user_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnnotationCreatePayload {
  document_id: string;
  page_number: number;
  highlighted_text: string;
  color?: AnnotationColor;
  comment?: string | null;
  visibility?: AnnotationVisibility;
  char_start?: number | null;
  char_end?: number | null;
  boxes?: number[][];
}

export interface AnnotationUpdatePayload {
  color?: AnnotationColor;
  comment?: string | null;
  visibility?: AnnotationVisibility;
}
