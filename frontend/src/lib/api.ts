import type {
  AdminLearnConceptRow,
  AdminLearnDocumentRow,
  AdminLearnQuestionRow,
  AdminLearnSectionDetail,
  AdminLearnSectionSummary,
  Annotation,
  AnnotationCreatePayload,
  AnnotationUpdatePayload,
  AuthTokenResponse,
  AdminFeatureIdea,
  AdminMessageFeedback,
  CheckInQuestion,
  CheckInResult,
  Company,
  CompanyUserAssignment,
  ConversationDetail,
  ConversationSummary,
  Document,
  DocumentUploadInitResponse,
  DocumentStatus,
  ExportDestination,
  ExportDestinationInfo,
  ExportWriteResponse,
  FeatureIdea,
  FeatureIdeaPriority,
  Group,
  GroupAssignment,
  LearnDepth,
  LearnPath,
  MessageFeedback,
  MessageFeedbackRating,
  MindmapChapterGroup,
  MindmapSectionNode,
  PageData,
  Project,
  PromptAttachment,
  User,
  WelcomePayload,
} from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api";
const TOKEN_KEY = "maia-axon-token";
const AUTH_STORE_KEY = "maia-axon-auth";
const PAGE_CACHE_KEY_PREFIX = "maia-page-cache-v1";

export function getStoredToken() {
  if (typeof window === "undefined") {
    return null;
  }

  const token = window.localStorage.getItem(TOKEN_KEY);
  if (token) {
    return token;
  }

  try {
    const persistedAuth = window.localStorage.getItem(AUTH_STORE_KEY);
    if (!persistedAuth) {
      return null;
    }
    const parsed = JSON.parse(persistedAuth) as { state?: { token?: unknown } };
    if (typeof parsed.state?.token === "string" && parsed.state.token) {
      window.localStorage.setItem(TOKEN_KEY, parsed.state.token);
      return parsed.state.token;
    }
  } catch {
    return null;
  }

  return null;
}

export function setStoredToken(token: string | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!token) {
    window.localStorage.removeItem(TOKEN_KEY);
    return;
  }
  window.localStorage.setItem(TOKEN_KEY, token);
}

function clearStoredAuth() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(AUTH_STORE_KEY);
}

// Track PDFs we've already kicked off a prefetch for so a hover or
// click doesn't trigger overlapping requests for the same file.
const _PDF_PREFETCH_INFLIGHT = new Set<string>();

/**
 * Start fetching the original PDF for a document in the background so
 * pdf.js finds the bytes in the HTTP cache by the time the preview
 * dialog mounts. Safe to call multiple times; the second call is a
 * no-op while the first is in flight.
 *
 * Uses a tiny initial Range header so the request is cheap even on
 * very large PDFs — pdf.js's later range requests then hit the cache
 * with the same headers, while the rest of the file streams in the
 * background.
 */
export async function prefetchPdfFile(documentId: string) {
  if (typeof window === "undefined") return;
  if (_PDF_PREFETCH_INFLIGHT.has(documentId)) return;
  const token = getStoredToken();
  if (!token) return;
  _PDF_PREFETCH_INFLIGHT.add(documentId);
  try {
    // First request: HEAD-style with Range 0- to warm the cache for
    // pdf.js's initial xref read. The browser will reuse this entry
    // for range requests pdf.js fires later.
    await fetch(`${API_URL}/documents/${documentId}/file`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Range: "bytes=0-",
      },
      cache: "default",
    });
  } catch {
    /* ignore — pdf.js will retry when the viewer mounts */
  } finally {
    // Keep the entry for a couple of seconds so rapid re-hovers
    // don't refetch, but clear eventually in case the response was
    // an error and we want a real retry path.
    setTimeout(() => _PDF_PREFETCH_INFLIGHT.delete(documentId), 5000);
  }
}

export async function prefetchAuthorized(path: string) {
  const token = getStoredToken();
  if (!token) {
    return;
  }

  try {
    await fetch(`${API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "force-cache",
    });
  } catch {
    // Best effort prefetch only.
  }
}

function pageCacheKey(documentId: string, pageNumber: number) {
  return `${PAGE_CACHE_KEY_PREFIX}:${documentId}:${pageNumber}`;
}

export function getCachedPageData(documentId: string, pageNumber: number): PageData | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(pageCacheKey(documentId, pageNumber));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as PageData;
  } catch {
    return null;
  }
}

function setCachedPageData(documentId: string, pageNumber: number, pageData: PageData) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(pageCacheKey(documentId, pageNumber), JSON.stringify(pageData));
  } catch {
    // Best effort only.
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init?.headers);

  if (!(init?.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearStoredAuth();
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.replace("/login");
      }
    }
    const fallback = `Request failed with status ${response.status}`;
    try {
      const data = (await response.json()) as { detail?: string };
      throw new Error(data.detail ?? fallback);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(fallback);
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  login(identifier: string, password: string) {
    return request<AuthTokenResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ identifier, password }),
    });
  },
  register(name: string, email: string, password: string, role = "user") {
    return request<AuthTokenResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password, role }),
    });
  },
  me() {
    return request<User>("/users/me");
  },
  listUsers() {
    return request<User[]>("/users");
  },
  createUser(payload: { username: string; password: string; role?: string }) {
    return request<User>("/users", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  listGroups() {
    return request<Group[]>("/groups");
  },
  listCompanies() {
    return request<Company[]>("/companies");
  },
  createCompany(payload: {
    name: string;
    ga4_property_id?: string | null;
    google_ads_customer_id?: string | null;
    google_ads_login_customer_id?: string | null;
  }) {
    return request<Company>("/companies", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  updateCompany(
    companyId: string,
    payload: {
      name?: string;
      ga4_property_id?: string | null;
      google_ads_customer_id?: string | null;
      google_ads_login_customer_id?: string | null;
    },
  ) {
    return request<Company>(`/companies/${companyId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
  deleteCompany(companyId: string) {
    return request<void>(`/companies/${companyId}`, { method: "DELETE" });
  },
  listCompanyUsers(companyId: string) {
    return request<User[]>(`/companies/${companyId}/users`);
  },
  assignCompanyUser(companyId: string, userId: string) {
    return request<CompanyUserAssignment>(`/companies/${companyId}/users`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    });
  },
  removeCompanyUser(companyId: string, userId: string) {
    return request<void>(`/companies/${companyId}/users/${userId}`, {
      method: "DELETE",
    });
  },
  getExportDestinationInfo() {
    return request<ExportDestinationInfo>("/export-destinations/info");
  },
  listExportDestinations() {
    return request<ExportDestination[]>("/export-destinations");
  },
  createExportDestination(payload: {
    company_id?: string | null;
    type: "google_doc" | "google_sheet";
    title?: string | null;
    url: string;
  }) {
    return request<ExportDestination>("/export-destinations", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  deleteExportDestination(destinationId: string) {
    return request<void>(`/export-destinations/${destinationId}`, {
      method: "DELETE",
    });
  },
  writeExportDestination(payload: {
    destination_id: string;
    title: string;
    content: string;
    search_mode?: string | null;
    company_name?: string | null;
    visualizations?: unknown[];
  }) {
    return request<ExportWriteResponse>("/export-destinations/write", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  listProjects() {
    return request<Project[]>("/projects");
  },
  createProject(payload: { name: string }) {
    return request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  updateProject(projectId: string, payload: { name?: string }) {
    return request<Project>(`/projects/${projectId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
  deleteProject(projectId: string) {
    return request<void>(`/projects/${projectId}`, { method: "DELETE" });
  },
  createGroup(payload: { name: string; description?: string }) {
    return request<Group>("/groups", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  updateGroup(groupId: string, payload: { name?: string; description?: string }) {
    return request<Group>(`/groups/${groupId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
  deleteGroup(groupId: string) {
    return request<void>(`/groups/${groupId}`, { method: "DELETE" });
  },
  listGroupUsers(groupId: string) {
    return request<User[]>(`/groups/${groupId}/users`);
  },
  assignUser(groupId: string, userId: string) {
    return request<GroupAssignment>(`/groups/${groupId}/assign`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    });
  },
  removeUser(groupId: string, userId: string) {
    return request<void>(`/groups/${groupId}/assign/${userId}`, {
      method: "DELETE",
    });
  },
  listDocuments(groupId: string) {
    return request<Document[]>(`/groups/${groupId}/documents`);
  },
  initDocumentUpload(groupId: string, file: File) {
    return request<DocumentUploadInitResponse>(`/groups/${groupId}/documents/uploads`, {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        file_size_bytes: file.size,
        content_type: file.type || "application/pdf",
      }),
    });
  },
  completeDocumentUpload(documentId: string) {
    return request<{ document: Document }>(`/documents/${documentId}/complete-upload`, {
      method: "POST",
    });
  },
  async uploadDocumentViaProxy(
    groupId: string,
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<Document> {
    const token = getStoredToken();

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_URL}/groups/${groupId}/documents`);

      if (token) {
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      }

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || !onProgress) {
          return;
        }
        onProgress(Math.round((event.loaded / event.total) * 100));
      };

      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText) as Document);
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText) as { detail?: string };
          reject(new Error(data.detail ?? "Upload failed"));
        } catch {
          reject(new Error("Upload failed"));
        }
      };

      const formData = new FormData();
      formData.append("file", file);
      xhr.send(formData);
    });
  },
  uploadDocument(
    groupId: string,
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<Document> {
    return api.initDocumentUpload(groupId, file).then(async (init) => {
      if (init.strategy === "proxy" || !init.upload_url || !init.document) {
        return api.uploadDocumentViaProxy(groupId, file, onProgress);
      }

      const uploadedDocument = init.document;
      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", init.upload_url!);
          xhr.setRequestHeader("Content-Type", file.type || "application/pdf");

          xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable || !onProgress) {
              return;
            }
            onProgress(Math.round((event.loaded / event.total) * 100));
          };

          xhr.onerror = () =>
            reject(
              new Error(
                "Upload failed. If the file is large, verify Cloud Storage CORS is configured for the frontend origin.",
              ),
            );
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
              return;
            }
            reject(new Error(`Upload failed with status ${xhr.status}`));
          };

          xhr.send(file);
        });

        const finalized = await api.completeDocumentUpload(uploadedDocument.id);
        return finalized.document;
      } catch (error) {
        try {
          await api.deleteDocument(uploadedDocument.id);
        } catch {
          // Best effort cleanup for incomplete direct uploads.
        }
        throw error;
      }
    });
  },
  getDocument(documentId: string) {
    return request<Document>(`/documents/${documentId}`);
  },
  // URL of the raw PDF file. Returned by the backend with auth required;
  // we feed both the URL and the bearer token to react-pdf via the
  // ``httpHeaders`` field on the Document file prop.
  getDocumentFileUrl(documentId: string) {
    return `${API_URL}/documents/${documentId}/file`;
  },
  getDocumentPageOffset(documentId: string) {
    return request<{ offset: number }>(`/documents/${documentId}/page-offset`);
  },
  getDocumentStatus(documentId: string) {
    return request<DocumentStatus>(`/documents/${documentId}/status`);
  },
  deleteDocument(documentId: string) {
    return request<void>(`/documents/${documentId}`, { method: "DELETE" });
  },
  reindexDocument(documentId: string) {
    return request<DocumentStatus>(`/documents/${documentId}/reindex`, {
      method: "POST",
    });
  },
  getPage(documentId: string, pageNumber: number) {
    const cached = getCachedPageData(documentId, pageNumber);
    if (cached) {
      return Promise.resolve(cached);
    }

    return request<PageData>(`/documents/${documentId}/pages/${pageNumber}`).then((pageData) => {
      setCachedPageData(documentId, pageNumber, pageData);
      return pageData;
    });
  },
  resolveDocumentPage(documentId: string, pageLabel: number, title?: string) {
    const suffix = title ? `?title=${encodeURIComponent(title)}` : "";
    return request<{ page_label: number; resolved_page: number }>(
      `/documents/${documentId}/resolve-page/${pageLabel}${suffix}`,
    );
  },
  resolveDocumentSection(documentId: string, title: string, fromPage?: number) {
    const params = new URLSearchParams({ title });
    if (typeof fromPage === "number") {
      params.set("from_page", String(fromPage));
    }
    return request<{ title: string; resolved_page: number }>(
      `/documents/${documentId}/resolve-section?${params.toString()}`,
    );
  },
  listConversations(projectId?: string | null) {
    const suffix = projectId ? `?project_id=${projectId}` : "";
    return request<ConversationSummary[]>(`/conversations${suffix}`);
  },
  createConversation(payload: { project_id?: string | null; group_id?: string | null }) {
    return request<ConversationSummary>("/conversations", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  getConversation(conversationId: string) {
    return request<ConversationDetail>(`/conversations/${conversationId}`);
  },
  deleteConversation(conversationId: string) {
    return request<void>(`/conversations/${conversationId}`, { method: "DELETE" });
  },
  truncateConversationFromMessage(conversationId: string, messageId: string) {
    return request<ConversationDetail>(`/conversations/${conversationId}/messages/${messageId}/truncate`, {
      method: "POST",
    });
  },
  getWelcome(groupId?: string | null) {
    const suffix = groupId ? `?group_id=${groupId}` : "";
    return request<WelcomePayload>(`/chat/welcome${suffix}`);
  },
  uploadPromptAttachment(file: File): Promise<PromptAttachment> {
    const token = getStoredToken();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_URL}/chat/attachments`);

      if (token) {
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      }

      xhr.onerror = () => reject(new Error("Attachment upload failed"));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText) as PromptAttachment);
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText) as { detail?: string };
          reject(new Error(data.detail ?? "Attachment upload failed"));
        } catch {
          reject(new Error("Attachment upload failed"));
        }
      };

      const formData = new FormData();
      formData.append("file", file);
      xhr.send(formData);
    });
  },
  submitMessageFeedback(payload: {
    message_id: string;
    rating: MessageFeedbackRating;
    tags?: string[];
    comment?: string | null;
  }) {
    return request<MessageFeedback>("/feedback/messages", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  submitFeatureIdea(payload: {
    category: string;
    title?: string | null;
    description: string;
    priority: FeatureIdeaPriority;
  }) {
    return request<FeatureIdea>("/feedback/ideas", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  listMessageFeedback() {
    return request<AdminMessageFeedback[]>("/feedback/admin/messages");
  },
  listFeatureIdeas() {
    return request<AdminFeatureIdea[]>("/feedback/admin/ideas");
  },
  updateFeatureIdeaStatus(ideaId: string, status: FeatureIdea["status"]) {
    return request<FeatureIdea>(`/feedback/admin/ideas/${ideaId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  },
  listAnnotations(documentId: string) {
    return request<Annotation[]>(`/annotations?document_id=${encodeURIComponent(documentId)}`);
  },
  createAnnotation(payload: AnnotationCreatePayload) {
    return request<Annotation>("/annotations", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  updateAnnotation(annotationId: string, payload: AnnotationUpdatePayload) {
    return request<Annotation>(`/annotations/${annotationId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },
  deleteAnnotation(annotationId: string) {
    return request<void>(`/annotations/${annotationId}`, { method: "DELETE" });
  },
  translateText(text: string, targetLanguage: string) {
    return request<{ translated_text: string; target_language: string }>("/translate", {
      method: "POST",
      body: JSON.stringify({ text, target_language: targetLanguage }),
    });
  },

  // ----- Learn mode -----

  startLearningPath(payload: {
    document_id: string;
    goal_text: string;
    depth: LearnDepth;
    prior_known_concept_ids?: string[];
  }) {
    return request<LearnPath>("/learn/path/start", {
      method: "POST",
      body: JSON.stringify({
        document_id: payload.document_id,
        goal_text: payload.goal_text,
        depth: payload.depth,
        prior_known_concept_ids: payload.prior_known_concept_ids ?? [],
      }),
    });
  },
  getActiveLearningPath(documentId: string) {
    return request<LearnPath>(`/learn/path/active?document_id=${encodeURIComponent(documentId)}`);
  },
  advanceLearningPath(pathId: string, payload: { skip: boolean }) {
    return request<LearnPath>(`/learn/path/${pathId}/advance`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  getSectionQuestions(sectionId: string) {
    return request<CheckInQuestion[]>(`/learn/section/${sectionId}/questions`);
  },
  submitCheckIn(payload: { question_id: string; user_answer: string }) {
    return request<CheckInResult>("/learn/check-in", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  getDocumentSections(documentId: string) {
    return request<MindmapSectionNode[]>(`/learn/document/${documentId}/sections`);
  },
  getDocumentChapterGroups(documentId: string) {
    return request<MindmapChapterGroup[]>(
      `/learn/document/${documentId}/chapter-groups`,
    );
  },

  // ----- Admin learn-mode review -----

  adminListLearnDocuments() {
    return request<AdminLearnDocumentRow[]>(`/admin/learn/documents`);
  },
  adminListLearnSections(documentId: string, flaggedOnly = false) {
    const suffix = flaggedOnly ? "?flagged_only=true" : "";
    return request<AdminLearnSectionSummary[]>(
      `/admin/learn/documents/${documentId}/sections${suffix}`,
    );
  },
  adminGetLearnSection(sectionId: string) {
    return request<AdminLearnSectionDetail>(`/admin/learn/sections/${sectionId}`);
  },
  adminPatchLearnSection(
    sectionId: string,
    payload: {
      title?: string;
      content_summary?: string;
      content_json?: Record<string, unknown>;
    },
  ) {
    return request<AdminLearnSectionDetail>(`/admin/learn/sections/${sectionId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },
  adminRegenerateLearnSection(sectionId: string) {
    return request<AdminLearnSectionDetail>(
      `/admin/learn/sections/${sectionId}/regenerate`,
      { method: "POST" },
    );
  },
  adminDeleteLearnSection(sectionId: string) {
    return request<void>(`/admin/learn/sections/${sectionId}`, { method: "DELETE" });
  },
  adminListLearnQuestions(sectionId: string) {
    return request<AdminLearnQuestionRow[]>(
      `/admin/learn/sections/${sectionId}/questions`,
    );
  },
  adminPatchLearnQuestion(
    questionId: string,
    payload: {
      stem?: string;
      explanation?: string;
      payload?: Record<string, unknown>;
      difficulty?: number;
      estimated_seconds?: number;
    },
  ) {
    return request<AdminLearnQuestionRow>(`/admin/learn/questions/${questionId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },
  adminDeleteLearnQuestion(questionId: string) {
    return request<void>(`/admin/learn/questions/${questionId}`, { method: "DELETE" });
  },
  adminRegenerateLearnQuestions(sectionId: string) {
    return request<AdminLearnQuestionRow[]>(
      `/admin/learn/sections/${sectionId}/questions/regenerate`,
      { method: "POST" },
    );
  },
  adminListLearnConcepts(documentId?: string) {
    const suffix = documentId ? `?document_id=${encodeURIComponent(documentId)}` : "";
    return request<AdminLearnConceptRow[]>(`/admin/learn/concepts${suffix}`);
  },
  adminMergeLearnConcepts(payload: { keep_id: string; absorb_id: string }) {
    return request<AdminLearnConceptRow>(`/admin/learn/concepts/merge`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  adminDeleteLearnConcept(conceptId: string) {
    return request<void>(`/admin/learn/concepts/${conceptId}`, { method: "DELETE" });
  },
};
