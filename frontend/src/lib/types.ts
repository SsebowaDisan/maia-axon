export type SearchMode = "library" | "deep_search" | "standard";

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
  bbox: number[] | null;
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

export interface MessageResponse {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  citations: { citations?: Citation[] } | null;
  mindmap: MindmapNode | null;
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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: PromptAttachment[];
  createdAt: string;
  citations: Citation[];
  mindmap: MindmapNode | null;
  warnings: string[];
  searchMode: SearchMode;
  isStreaming: boolean;
  status: StreamingStatus;
  needsClarification: boolean;
}

export interface PromptAttachment {
  id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
}

export interface ChatQueryPayload {
  type: "query";
  project_id: string | null;
  group_id: string | null;
  document_ids: string[];
  attachment_ids: string[];
  mode: SearchMode;
  message: string;
  conversation_id: string | null;
}

export type WsServerEvent =
  | { type: "status"; status: Exclude<StreamingStatus, "idle" | "done"> }
  | { type: "token"; content: string }
  | { type: "citations"; data: Citation[] }
  | { type: "mindmap"; data: MindmapNode }
  | { type: "warnings"; data: string[] }
  | { type: "done"; conversation_id: string }
  | { type: "error"; message: string };

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
