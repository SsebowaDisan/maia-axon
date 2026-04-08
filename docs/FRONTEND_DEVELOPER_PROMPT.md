# Maia Axon — Frontend Developer Prompt

## What You're Building

Maia Axon is a **document reasoning system** for engineering teams. Admins upload scanned, image-heavy, formula-heavy PDFs into groups. Users select a group, ask questions, and get grounded answers with step-by-step calculations and clickable citations that open a PDF viewer with highlighted evidence.

This is NOT a generic chatbot. It is a **group-scoped engineering copilot** with strict evidence tracing, calculation capabilities, and a provenance mindmap.

---

## Tech Stack

| Tool | Purpose |
|------|---------|
| Next.js 14 (App Router) | Framework |
| TypeScript | Language (strict mode) |
| Tailwind CSS + shadcn/ui | Styling + component library |
| Zustand | State management |
| react-resizable-panels | 3-panel resizable layout |
| react-pdf / PDF.js | PDF rendering |
| React Flow | Mindmap visualization |
| react-markdown + KaTeX | Markdown + LaTeX rendering |
| react-dropzone | File uploads (admin) |
| Native WebSocket API | Streaming chat |

---

## Backend API

The backend is already built (FastAPI + PostgreSQL + Redis + MinIO). The frontend connects to it via:

- **REST API** at `http://localhost:8000/api/...`
- **WebSocket** at `ws://localhost:8000/ws/chat?token=JWT_TOKEN`

### Authentication

All REST requests require `Authorization: Bearer <JWT_TOKEN>` header.
WebSocket authenticates via `?token=JWT_TOKEN` query parameter.

Tokens are obtained from `POST /api/auth/login` or `POST /api/auth/register`.

### Key API Endpoints

```
AUTH
  POST   /api/auth/register        → { access_token, user }
  POST   /api/auth/login           → { access_token, user }

USERS
  GET    /api/users/me             → current user
  GET    /api/users                → all users (admin only)

GROUPS (# command)
  GET    /api/groups               → list user's groups (with doc_count, user_count)
  POST   /api/groups               → create group (admin)
  PUT    /api/groups/{id}          → update group (admin)
  DELETE /api/groups/{id}          → delete group (admin)
  POST   /api/groups/{id}/assign   → assign user to group (admin)
  DELETE /api/groups/{id}/assign/{user_id}  → remove user (admin)
  GET    /api/groups/{id}/users    → list users in group (admin)

DOCUMENTS (@ command)
  GET    /api/groups/{id}/documents     → list docs in group
  POST   /api/groups/{id}/documents     → upload PDF (admin, multipart)
  GET    /api/documents/{id}            → get document
  GET    /api/documents/{id}/status     → polling: { status, page_count, error_detail }
  DELETE /api/documents/{id}            → delete (admin)
  POST   /api/documents/{id}/reindex    → re-process (admin)
  GET    /api/documents/{id}/pages/{n}  → get page data (image_url, regions, markdown)

CONVERSATIONS
  GET    /api/conversations             → list (optional ?group_id= filter)
  POST   /api/conversations             → create { group_id }
  GET    /api/conversations/{id}        → get with messages
  DELETE /api/conversations/{id}

CHAT (non-streaming fallback)
  POST   /api/chat                      → { conversation_id?, group_id, document_ids?, mode, message }
```

### WebSocket Protocol

```
Client → Server:
{
  "type": "query",
  "group_id": "uuid",
  "document_ids": ["uuid", ...],   // optional, from @ selection
  "mode": "library" | "deep_search",
  "message": "user's question",
  "conversation_id": "uuid"         // optional, null for new conversation
}

Server → Client (in order):
{ "type": "status", "status": "retrieving" }
{ "type": "status", "status": "reasoning" }
{ "type": "status", "status": "calculating" }     // only for calculation questions
{ "type": "token", "content": "The" }             // streamed tokens
{ "type": "token", "content": " heat" }
... more tokens ...
{ "type": "citations", "data": [...] }            // after text is complete
{ "type": "mindmap", "data": {...} }              // after citations
{ "type": "warnings", "data": ["..."] }           // optional
{ "type": "done", "conversation_id": "uuid" }
{ "type": "error", "message": "..." }             // on failure
```

### Citation Object Shape

```typescript
interface Citation {
  id: string;                    // "cite-1"
  source_type: "pdf" | "web";
  document_id: string | null;    // UUID
  document_name: string;
  page: number;
  bbox: number[] | null;         // [x1, y1, x2, y2] or null
  snippet: string;               // preview text
  url: string | null;            // for web sources
  title: string | null;
}
```

### Mindmap Object Shape

```typescript
interface MindmapNode {
  id: string;
  label: string;
  node_type: "answer" | "pdf_source" | "web_source" | "user_input" | "model_reasoning";
  source?: Citation;
  children: MindmapNode[];
}
```

### Document Status Values

```
"uploading" → "splitting" → "glm_ocr" → "captioning" → "embedding" → "ready"
                                                                       ↓
                                                                   "failed"
```

---

## Application Layout

### Three-Panel Resizable Layout

Use `react-resizable-panels` for the three-panel layout with draggable dividers.

```
┌──────────────┬──╋──┬──────────────────────┬──╋──┬─────────────────────┐
│ Panel 1      │     │ Panel 2              │     │ Panel 3             │
│ History      │ ↔   │ Chat                 │ ↔   │ Mindmap + PDF       │
│ (260px)      │     │ (flex)               │     │ (420px)             │
│              │     │                      │     │ (collapsible)       │
└──────────────┴─────┴──────────────────────┴─────┴─────────────────────┘
```

| Panel | Default | Min | Max | Notes |
|-------|---------|-----|-----|-------|
| 1 - History | 260px | 200px | 400px | |
| 2 - Chat | Fills remaining | 400px | No max | |
| 3 - Mindmap+PDF | 420px | 300px | 700px | Collapsible to 0px |

- Save panel widths to localStorage and restore on reload
- Drag handles: 4px wide, `col-resize` cursor on hover
- Right panel collapses entirely when no PDF is open (toggle button or drag to min)

### Responsive Behavior

| Viewport | Behavior |
|----------|----------|
| >1200px | All 3 panels visible, resizable |
| 768–1200px | Panel 1 collapses to icon sidebar, Panel 3 opens as overlay |
| <768px | Tab-based navigation between panels |

---

## Panel 1 — Conversation History

### What to Build

A sidebar showing the user's past conversations, grouped by date.

### Data Flow

1. On mount, fetch `GET /api/conversations`
2. Group by date: Today, Yesterday, Last 7 Days, Last 30 Days, Older
3. Each item shows: title (auto-generated from first message), group badge, relative time
4. Click loads conversation: `GET /api/conversations/{id}` → populates Panel 2 with messages
5. Hover shows delete icon → confirmation dialog → `DELETE /api/conversations/{id}`

### Elements

- **Search bar** at top: client-side filter on conversation titles
- **+ New Chat** button: clears Panel 2, prompts user to select group via `#`
- **Manage** button (visible only when `user.role === "admin"`): replaces history content with admin interface
- **User info** at bottom: name + role from `GET /api/users/me`

### Active State

The currently active conversation should be visually highlighted (background color change).

---

## Panel 2 — Current Chat

This is the most complex panel. It has two parts: the **message area** (scrollable) and the **composer** (fixed at bottom).

### Message Area

#### User Messages

Simple text bubble. Left-aligned or right-aligned (your design choice, be consistent).

#### Assistant Messages

Render with `react-markdown` and the following custom components:

1. **LaTeX**: Use KaTeX to render any `$...$` (inline) and `$$...$$` (block) expressions.

2. **Inline Citations**: The assistant text contains `[Source N]` references. Parse these and render them as clickable citation chips (small blue pill badges). On click, the citation chip should:
   - Open the cited PDF in Panel 3's PDF viewer
   - Scroll to the correct page
   - If `bbox` is available, overlay a semi-transparent yellow highlight on that region

3. **Citation hover**: Show a tooltip with document name, page number, and snippet text.

4. **Sources section**: After the main answer text, render a "Sources" block listing all citations with their details. Each source is clickable (same behavior as inline citations).

5. **Calculation blocks**: When the response contains calculation steps, render them in a visually distinct block:
   - Each step on its own line
   - Steps from PDFs: left blue border + document icon + citation
   - Steps from user input: user icon
   - Steps from model reasoning: dashed gray border + brain icon
   - Final result: highlighted (green background or bold)

6. **OCR warnings**: If `warnings` array is present, render a yellow/amber banner above the answer text.

7. **Clarification questions**: If `needs_clarification` is true in the response, render the clarification question in a distinct style (e.g., a card with a question mark icon).

#### Streaming Behavior

During streaming:
1. Show status indicator based on `status` messages: "Searching documents...", "Reasoning...", "Calculating..."
2. As `token` messages arrive, append them to the current assistant message in real-time
3. After `citations` message arrives, parse the answer text for `[Source N]` references and make them clickable
4. After `mindmap` message arrives, update the mindmap in Panel 3
5. After `done` message, finalize the message and save the `conversation_id` for future messages

Auto-scroll to the bottom as new content streams in.

### Composer

Fixed at the bottom of Panel 2. Contains:

#### Top Row: Chips and Controls

- **`+` button** (left): Opens a small dropdown menu with two options:
  - `Library` — sets search mode to `"library"`
  - `Deep Search` — sets search mode to `"deep_search"`
  - Show the currently active mode as a small badge/chip

- **Group chip**: Shows the currently selected group name. Appears after user selects a group via `#`. Click the chip to change group (re-opens `#` selector). Remove chip to deselect.

- **Document chips**: Shows selected document names (if narrowed via `@`). Each chip has an `×` to remove. If none selected, all documents in group are searched.

#### Bottom Row: Input + Send

- **Textarea**: Auto-resizes vertically as user types (min 1 line, max 6 lines). Placeholder text depends on state:
  - No group selected: "Select a group with # to start"
  - Group selected: "Ask a question..."

- **Send button**: Arrow-up icon. Disabled when:
  - No group is selected
  - Input is empty
  - Response is streaming

#### Special Input Triggers

**`#` trigger**: When user types `#` in the textarea:
1. Open a floating dropdown above the composer
2. Fetch `GET /api/groups` and display as searchable list
3. Each item shows: group name + document count
4. On select: set as active group, replace `#` text with nothing, show group chip
5. Dismiss on Escape or click outside

**`@` trigger**: When user types `@` in the textarea (only works when a group is already selected):
1. Open a floating dropdown above the composer
2. Fetch `GET /api/groups/{active_group_id}/documents` and display as searchable checkbox list
3. Top option: "All documents" (default, checked)
4. User can toggle individual documents on/off
5. Selected docs appear as chips in the composer
6. Dismiss on Escape or click outside

#### Sending a Message

On send (Enter key or send button click):
1. Add user message to the message list (optimistic display)
2. Open WebSocket connection if not already open
3. Send:
```json
{
  "type": "query",
  "group_id": "active-group-uuid",
  "document_ids": ["uuid", ...] or [],
  "mode": "library" or "deep_search",
  "message": "user's text",
  "conversation_id": "uuid or null"
}
```
4. Clear the input
5. Show streaming indicator
6. As tokens arrive, build the assistant message
7. On `done`, finalize and store `conversation_id`

---

## Panel 3 — Mindmap + PDF Renderer

This panel is split vertically into two sections: mindmap on top, PDF viewer on bottom. The split is also resizable (vertical drag handle).

### Collapsible

- When no PDF is loaded and no mindmap exists, the panel should be collapsed
- A small toggle button on the left edge of the divider allows manual collapse/expand
- Keyboard shortcut: `Ctrl/Cmd + /`

### Mindmap Section (Top)

Use **React Flow** to render an interactive provenance graph.

#### Data Source

The mindmap data comes from the WebSocket `mindmap` message or from `message.mindmap` in stored messages.

#### Rendering

Convert the `MindmapNode` tree into React Flow nodes and edges:

- **Root node** (type: `"answer"`): Bold border, centered at top, shows truncated answer text
- **PDF source nodes**: Document icon + "filename, p.XX". Solid border.
- **Web source nodes**: Globe icon + domain name. Solid border.
- **User input nodes**: User icon + label. Light border.
- **Model reasoning nodes**: Brain icon + "Model reasoning (uncited)". Dashed border.

Layout: Use dagre or elk layout algorithm for automatic tree layout (top-down).

#### Interactions

| Action | Behavior |
|--------|----------|
| Click PDF node | Open that document in PDF viewer below at the cited page. If `bbox` exists, highlight that region. |
| Click web node | `window.open(url, '_blank')` |
| Hover any node | Tooltip showing the full snippet from the citation |
| Scroll wheel | Zoom in/out |
| Drag background | Pan |
| Minimize button | Collapse mindmap to a thin 32px bar showing "Mindmap ▾" |

#### Empty State

When no answer has been given yet:
```
Ask a question to see how the answer is constructed
```

#### Updates

- Clear and rebuild the mindmap each time a new assistant response arrives
- Animate the transition when new nodes appear

### PDF Viewer Section (Bottom)

#### Library

Use `react-pdf` (which wraps PDF.js) or raw PDF.js.

#### Loading a PDF

When a citation is clicked (from chat or mindmap):
1. Get the `document_id` and `page` number from the citation
2. Construct the PDF URL: `{S3_ENDPOINT}/maia-axon/documents/{document_id}/original.pdf`
3. Load the PDF in the viewer
4. Scroll to the specified page
5. If `bbox` is provided, overlay a highlight

#### Toolbar

Render above the PDF:
- Document filename
- Zoom controls: `−` / `+` / `Fit to width`
- Page navigation: `◀` Previous / Current page number (editable input) / Total pages / `▶` Next
- Close button: `×` — closes the PDF viewer and collapses Panel 3

#### Highlight Overlay

When a citation has `bbox: [x1, y1, x2, y2]`:
1. Calculate the position relative to the rendered PDF page
2. Overlay a `<div>` with semi-transparent yellow background (`rgba(255, 220, 0, 0.3)`)
3. Position it absolutely over the PDF page at the bbox coordinates
4. Support multiple highlights on the same page
5. Highlights clear when user navigates to a different page or clicks "clear"

When no `bbox` is available (page-level citation):
- Just scroll to the page, no highlight rectangle

#### Behavior Rules

- **NO auto-jump**: The PDF viewer never navigates on its own. It only responds to user clicks (citation clicks or mindmap node clicks).
- **Remember position**: When switching between PDFs, remember the scroll position for each.
- **Page-level citation**: If no bbox, just navigate to the page.

#### Empty State

```
Click a citation or mindmap node to view the source document
```

---

## Admin Interface

The admin interface renders **inside Panel 1**, replacing the conversation history when the admin clicks "Manage". A `← Back to chats` link returns to the history view.

### Tab Navigation

Three tabs at the top: **Groups** | **Documents** | **Users**

### Groups Tab

1. Fetch `GET /api/groups` (admin sees all groups)
2. Display as cards: group name, doc count, user count
3. `+ Create Group` button → inline form (name, description) → `POST /api/groups`
4. Each group has Edit and Delete buttons
5. Edit → inline editing of name/description → `PUT /api/groups/{id}`
6. Delete → confirmation dialog → `DELETE /api/groups/{id}`
7. Click a group name → switches to Documents tab for that group

### Documents Tab

1. Shows documents for the selected group
2. Fetch `GET /api/groups/{id}/documents`
3. **Upload zone**: `react-dropzone` area. Accept only `.pdf`. Multi-file.
4. On drop/select: `POST /api/groups/{id}/documents` (multipart form data) for each file
5. Show upload progress per file

#### Document Cards

Each document card shows:
- Filename
- File size + page count
- Status indicator (see below)
- Actions: Replace, Delete (with confirmation), Retry (if failed)

#### Status Polling

After upload, poll `GET /api/documents/{id}/status` every 3 seconds until status is `"ready"` or `"failed"`.

Display:
| Status | Visual |
|--------|--------|
| `uploading` | Upload icon + progress bar |
| `splitting` | Spinner + "Splitting pages..." |
| `glm_ocr` | Spinner + "Analyzing document (OCR)..." |
| `captioning` | Spinner + "Processing figures..." |
| `embedding` | Spinner + "Generating embeddings..." |
| `ready` | Green dot + "Ready" |
| `failed` | Red dot + error_detail text + Retry button |

Retry button calls `POST /api/documents/{id}/reindex`.

### Users Tab

1. Select a group first (show group selector if none selected)
2. Fetch `GET /api/groups/{id}/users`
3. Display list of assigned users with Remove button
4. `+ Assign User` section: search bar that searches `GET /api/users`, shows results, click to assign via `POST /api/groups/{id}/assign { user_id }`
5. Remove: `DELETE /api/groups/{id}/assign/{user_id}` with confirmation

---

## Zustand Stores

### `chatStore`

```typescript
interface ChatStore {
  messages: Message[];
  isStreaming: boolean;
  streamingStatus: string | null;  // "retrieving", "reasoning", "calculating"
  currentStreamText: string;

  sendMessage: (text: string) => void;
  appendToken: (token: string) => void;
  setCitations: (citations: Citation[]) => void;
  setMindmap: (mindmap: MindmapNode) => void;
  setComplete: (conversationId: string) => void;
  clearChat: () => void;
}
```

### `groupStore`

```typescript
interface GroupStore {
  groups: Group[];
  activeGroup: Group | null;
  loading: boolean;

  fetchGroups: () => Promise<void>;
  setActiveGroup: (group: Group) => void;
  createGroup: (data: GroupCreate) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
}
```

Persist `activeGroup` to localStorage so it survives page reloads.

### `documentStore`

```typescript
interface DocumentStore {
  documents: Document[];
  selectedDocumentIds: string[];  // from @ selection, empty = all
  loading: boolean;

  fetchDocuments: (groupId: string) => Promise<void>;
  selectDocuments: (ids: string[]) => void;
  clearSelection: () => void;
  uploadDocument: (groupId: string, file: File) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
}
```

### `pdfViewerStore`

```typescript
interface PdfViewerStore {
  currentDocumentId: string | null;
  currentDocumentName: string;
  currentPage: number;
  totalPages: number;
  highlights: { page: number; bbox: number[] }[];
  zoom: number;
  scrollPositions: Record<string, number>;  // documentId → scroll position

  openPdf: (documentId: string, documentName: string, page: number, bbox?: number[]) => void;
  goToPage: (page: number) => void;
  addHighlight: (page: number, bbox: number[]) => void;
  clearHighlights: () => void;
  setZoom: (zoom: number) => void;
  closePdf: () => void;
}
```

### `mindmapStore`

```typescript
interface MindmapStore {
  data: MindmapNode | null;
  isMinimized: boolean;

  setMindmapData: (data: MindmapNode) => void;
  clearMindmap: () => void;
  toggleMinimize: () => void;
}
```

---

## Folder Structure

```
src/
├── app/
│   ├── layout.tsx                 # Root layout
│   ├── page.tsx                   # Main app (3-panel layout, requires auth)
│   └── login/
│       └── page.tsx               # Login page
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx           # 3-panel container with react-resizable-panels
│   │   ├── SidebarHistory.tsx     # Panel 1: conversation list
│   │   ├── ChatPanel.tsx          # Panel 2: messages + composer
│   │   └── DocumentPanel.tsx      # Panel 3: mindmap + PDF viewer
│   ├── chat/
│   │   ├── MessageList.tsx        # Scrollable message area
│   │   ├── MessageBubble.tsx      # Single message (user or assistant)
│   │   ├── AssistantMessage.tsx   # Complex assistant message with citations, calc steps
│   │   ├── CalculationBlock.tsx   # Step-by-step calculation display
│   │   ├── Composer.tsx           # Input area with # @ + controls
│   │   ├── ComposerMenu.tsx      # + button dropdown (Library / Deep Search)
│   │   ├── GroupSelector.tsx      # # dropdown
│   │   ├── DocumentSelector.tsx   # @ dropdown with checkboxes
│   │   ├── CitationChip.tsx       # Clickable inline [¹] badge
│   │   ├── SourcesBlock.tsx       # Sources section at bottom of answer
│   │   ├── StreamingIndicator.tsx # "Searching...", "Reasoning..." status
│   │   └── OcrWarning.tsx         # Yellow warning banner
│   ├── pdf/
│   │   ├── PdfViewer.tsx          # PDF renderer with pages
│   │   ├── PdfToolbar.tsx         # Zoom, page nav, close
│   │   ├── HighlightOverlay.tsx   # Yellow bbox overlay on PDF page
│   │   └── PdfEmptyState.tsx      # "Click a citation..." placeholder
│   ├── mindmap/
│   │   ├── MindmapCanvas.tsx      # React Flow container
│   │   ├── MindmapNode.tsx        # Custom node component (per type)
│   │   └── MindmapEmptyState.tsx  # Placeholder text
│   ├── admin/
│   │   ├── AdminPanel.tsx         # Container with tabs
│   │   ├── GroupManager.tsx       # Group CRUD
│   │   ├── DocumentUploader.tsx   # Drag-and-drop upload + status
│   │   ├── IndexingStatus.tsx     # Status badge per document
│   │   └── UserAssignment.tsx     # Assign/remove users
│   └── shared/
│       ├── LaTeXRenderer.tsx      # KaTeX wrapper
│       ├── MarkdownRenderer.tsx   # react-markdown with LaTeX + citation support
│       ├── ConfirmDialog.tsx      # Reusable confirmation modal
│       └── Toast.tsx              # Toast notifications
├── stores/
│   ├── chatStore.ts
│   ├── groupStore.ts
│   ├── documentStore.ts
│   ├── pdfViewerStore.ts
│   └── mindmapStore.ts
├── lib/
│   ├── api.ts                     # REST API client (fetch wrapper with auth)
│   ├── ws.ts                      # WebSocket client with reconnection
│   ├── types.ts                   # Shared TypeScript interfaces
│   └── utils.ts                   # Helpers (date formatting, etc.)
└── hooks/
    ├── useAuth.ts                 # Auth state + redirect
    ├── useChat.ts                 # Chat logic (send, stream, receive)
    ├── useGroups.ts               # Group fetching + selection
    ├── useDocuments.ts            # Document fetching + selection
    ├── usePdfViewer.ts            # PDF navigation + highlighting
    └── useMindmap.ts              # Mindmap data + interactions
```

---

## Detailed Component Behavior

### AppShell.tsx

```tsx
// Uses react-resizable-panels
<PanelGroup direction="horizontal">
  <Panel defaultSize={20} minSize={15} maxSize={30}>
    <SidebarHistory />
  </Panel>
  <PanelResizeHandle />
  <Panel minSize={30}>
    <ChatPanel />
  </Panel>
  <PanelResizeHandle />
  <Panel defaultSize={30} minSize={0} maxSize={50} collapsible>
    <DocumentPanel />
  </Panel>
</PanelGroup>
```

### CitationChip.tsx

When clicked:
1. Read citation data (document_id, page, bbox)
2. Call `pdfViewerStore.openPdf(document_id, document_name, page, bbox)`
3. If Panel 3 is collapsed, expand it
4. PDF viewer loads the document, scrolls to page, renders highlight

### WebSocket Connection (ws.ts)

```typescript
class MaiaWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  connect(token: string) {
    this.ws = new WebSocket(`ws://localhost:8000/ws/chat?token=${token}`);

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "status":   // update streaming status indicator
        case "token":    // append to current message
        case "citations": // attach citations to message
        case "mindmap":  // update mindmap
        case "warnings": // show warning banners
        case "done":     // finalize message
        case "error":    // show error toast
      }
    };

    this.ws.onclose = () => {
      // Exponential backoff reconnection
    };
  }

  send(query: ChatQuery) {
    this.ws?.send(JSON.stringify({ type: "query", ...query }));
  }
}
```

Reconnection: exponential backoff starting at 1s, max 30s, up to 5 attempts. Show "Reconnecting..." indicator.

### MarkdownRenderer.tsx

Custom `react-markdown` with these transformations:

1. **LaTeX**: Detect `$...$` and `$$...$$`, render with KaTeX
2. **Citations**: Detect `[Source N]` or `[¹]` patterns, replace with `<CitationChip>` components
3. **Tables**: Render markdown tables with proper styling
4. **Code blocks**: Syntax highlighting for any code in responses

### Composer.tsx — Trigger Detection

Monitor the textarea input for trigger characters:

```typescript
const handleInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
  const value = e.target.value;
  const cursorPos = e.target.selectionStart;

  // Check if user just typed #
  if (value[cursorPos - 1] === '#') {
    openGroupSelector();
  }

  // Check if user just typed @ (and group is selected)
  if (value[cursorPos - 1] === '@' && activeGroup) {
    openDocumentSelector();
  }
};
```

When a group is selected from the dropdown:
- Remove the `#` character from the input
- Set the group in `groupStore`
- Show group chip above the textarea

### Status Polling for Document Uploads

After uploading a document, poll status every 3 seconds:

```typescript
const pollStatus = async (documentId: string) => {
  const interval = setInterval(async () => {
    const { status, error_detail } = await api.get(`/documents/${documentId}/status`);
    updateDocumentStatus(documentId, status, error_detail);

    if (status === 'ready' || status === 'failed') {
      clearInterval(interval);
    }
  }, 3000);
};
```

---

## Styling Guidelines

- Use shadcn/ui components as base (Button, Input, Dialog, Dropdown, Tabs, etc.)
- Tailwind for custom styling
- Support dark mode via Tailwind `dark:` variant
- Color palette:
  - Citation chips: blue (`bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200`)
  - PDF highlight: yellow (`bg-yellow-300/30`)
  - Grounded step border: `border-l-4 border-blue-500`
  - Uncited step border: `border-l-4 border-dashed border-gray-400`
  - Warning banner: `bg-amber-50 border-amber-200 text-amber-800`
  - Ready status: green dot
  - Failed status: red dot
  - Processing: blue spinner

---

## Edge Cases to Handle

1. **No groups**: Show empty state in composer: "No groups available. Ask your admin to assign you to a group."
2. **Empty group** (no documents): Allow chat but warn: "This group has no documents yet."
3. **Long streaming response**: Auto-scroll, but stop auto-scrolling if user scrolls up manually. Resume when user scrolls back to bottom.
4. **WebSocket disconnect during streaming**: Show error toast, offer retry button to resend the last message.
5. **Large PDF** (300+ pages): Lazy-load pages in the PDF viewer. Only render visible pages + buffer.
6. **Multiple conversations in same group**: Conversations are independent. Switching conversations keeps the same active group.
7. **Citation to deleted document**: Show toast "Document no longer available" instead of crashing.
8. **Mobile**: On mobile, the `#` `@` `+` controls should still work but as bottom-sheet modals instead of floating dropdowns.
9. **Concurrent uploads**: Admin can upload multiple files at once. Show individual progress for each.

---

## Build Order (Recommended)

1. **Login page + auth flow** — get tokens working
2. **AppShell + 3-panel layout** — resizable panels with placeholders
3. **Sidebar (Panel 1)** — conversation list from API
4. **Composer** — input with `#` `@` `+` triggers
5. **Message display** — static messages from API (non-streaming first)
6. **WebSocket streaming** — real-time token streaming
7. **Citation rendering** — inline chips + sources section
8. **PDF viewer (Panel 3)** — load PDF, navigate, highlight
9. **Mindmap (Panel 3)** — React Flow graph from mindmap data
10. **Calculation blocks** — step-by-step rendering
11. **Admin interface** — groups, documents, users
12. **Polish** — dark mode, responsive, keyboard shortcuts, error handling
