import type {
  AuthTokenResponse,
  AdminFeatureIdea,
  AdminMessageFeedback,
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
  MessageFeedback,
  MessageFeedbackRating,
  PageData,
  Project,
  PromptAttachment,
  User,
  WelcomePayload,
} from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api";
const TOKEN_KEY = "maia-axon-token";
const PAGE_CACHE_KEY_PREFIX = "maia-page-cache-v1";

export function getStoredToken() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(TOKEN_KEY);
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
      setStoredToken(null);
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
};
