import type {
  AuthTokenResponse,
  ConversationDetail,
  ConversationSummary,
  Document,
  DocumentUploadInitResponse,
  DocumentStatus,
  Group,
  GroupAssignment,
  PageData,
  PromptAttachment,
  User,
  WelcomePayload,
} from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api";
const TOKEN_KEY = "maia-axon-token";

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
    return request<PageData>(`/documents/${documentId}/pages/${pageNumber}`);
  },
  listConversations(groupId?: string | null) {
    const suffix = groupId ? `?group_id=${groupId}` : "";
    return request<ConversationSummary[]>(`/conversations${suffix}`);
  },
  createConversation(groupId: string) {
    return request<ConversationSummary>("/conversations", {
      method: "POST",
      body: JSON.stringify({ group_id: groupId }),
    });
  },
  getConversation(conversationId: string) {
    return request<ConversationDetail>(`/conversations/${conversationId}`);
  },
  deleteConversation(conversationId: string) {
    return request<void>(`/conversations/${conversationId}`, { method: "DELETE" });
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
};
