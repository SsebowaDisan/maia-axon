# Frontend Tasks — Maia Axon

## Phase 0: Project Setup

- [ ] **F-001** Initialize Next.js 14 project with App Router and TypeScript
- [ ] **F-002** Configure Tailwind CSS + shadcn/ui
- [ ] **F-003** Set up Zustand for state management
- [ ] **F-004** Set up project folder structure (see below)
- [ ] **F-005** Configure environment variables for API URL, WebSocket URL
- [ ] **F-006** Set up ESLint + Prettier
- [ ] **F-007** Create API client layer (fetch wrapper with auth headers)
- [ ] **F-008** Create WebSocket client with reconnection logic
- [ ] **F-009** Set up basic CI (lint, type check, build)

### Folder Structure
```
src/
├── app/                    # Next.js App Router pages
│   ├── layout.tsx
│   ├── page.tsx            # Main app (3-panel layout)
│   ├── login/
│   └── admin/
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx          # 3-panel container
│   │   ├── SidebarHistory.tsx    # Left panel
│   │   ├── ChatPanel.tsx         # Center panel
│   │   └── DocumentPanel.tsx     # Right panel (PDF + mindmap)
│   ├── chat/
│   │   ├── MessageList.tsx
│   │   ├── MessageBubble.tsx
│   │   ├── Composer.tsx          # Input with # @ +
│   │   ├── ComposerMenu.tsx      # + menu (Library, Deep Search)
│   │   ├── GroupSelector.tsx      # # dropdown
│   │   ├── DocumentSelector.tsx   # @ dropdown
│   │   ├── Citation.tsx           # Clickable citation chip
│   │   ├── CalculationSteps.tsx   # Step-by-step display
│   │   └── StreamingIndicator.tsx
│   ├── pdf/
│   │   ├── PDFViewer.tsx
│   │   ├── PageRenderer.tsx
│   │   ├── HighlightOverlay.tsx   # Bbox highlight on page
│   │   └── PDFToolbar.tsx
│   ├── mindmap/
│   │   ├── MindmapCanvas.tsx
│   │   ├── MindmapNode.tsx
│   │   └── MindmapEdge.tsx
│   ├── admin/
│   │   ├── GroupManager.tsx
│   │   ├── DocumentUploader.tsx
│   │   ├── UserAssignment.tsx
│   │   └── IndexingStatus.tsx
│   └── shared/
│       ├── LaTeXRenderer.tsx
│       ├── MarkdownRenderer.tsx
│       ├── LoadingSpinner.tsx
│       └── ErrorBoundary.tsx
├── stores/
│   ├── chatStore.ts
│   ├── groupStore.ts
│   ├── documentStore.ts
│   ├── pdfViewerStore.ts
│   └── mindmapStore.ts
├── lib/
│   ├── api.ts             # REST API client
│   ├── ws.ts              # WebSocket client
│   ├── types.ts           # Shared TypeScript types
│   └── utils.ts
└── hooks/
    ├── useChat.ts
    ├── useGroups.ts
    ├── useDocuments.ts
    ├── usePDFViewer.ts
    └── useMindmap.ts
```

---

## Phase 1: Layout & Navigation

### 3-Panel Layout
- [ ] **F-101** Build AppShell: resizable 3-panel layout (left, center, right)
- [ ] **F-102** Implement panel resize handles (drag to resize)
- [ ] **F-103** Make right panel collapsible (hide when no PDF is open)
- [ ] **F-104** Responsive behavior: on small screens, panels stack or tab-switch

### Left Panel — Conversation History
- [ ] **F-105** Build SidebarHistory component
- [ ] **F-106** List conversations grouped by date (Today, Yesterday, Last 7 days, etc.)
- [ ] **F-107** Show conversation title + group badge
- [ ] **F-108** Click to load conversation
- [ ] **F-109** Delete conversation (with confirmation)
- [ ] **F-110** "New Chat" button

---

## Phase 2: Chat Interface

### Composer
- [ ] **F-201** Build Composer: text input with auto-resize
- [ ] **F-202** Implement `#` trigger: typing `#` opens GroupSelector dropdown
- [ ] **F-203** Build GroupSelector: searchable list of user's groups from API
- [ ] **F-204** Implement `@` trigger: typing `@` opens DocumentSelector dropdown
- [ ] **F-205** Build DocumentSelector: searchable list of docs in active group from API
- [ ] **F-206** Show selected group as a badge/chip in the composer
- [ ] **F-207** Show selected documents as badges/chips in the composer
- [ ] **F-208** Implement `+` button: opens ComposerMenu
- [ ] **F-209** Build ComposerMenu with two options: Library, Deep Search
- [ ] **F-210** Show active search mode indicator (Library or Deep Search)
- [ ] **F-211** Submit on Enter (Shift+Enter for newline)
- [ ] **F-212** Disable submit when no group is active

### Message Display
- [ ] **F-213** Build MessageList with auto-scroll to bottom
- [ ] **F-214** Build MessageBubble for user messages
- [ ] **F-215** Build MessageBubble for assistant messages with:
  - Markdown rendering
  - LaTeX/KaTeX rendering for equations
  - Inline citation chips (clickable)
  - "From PDF" vs "Model reasoning" visual distinction
- [ ] **F-216** Build CalculationSteps component:
  - Numbered steps
  - Formula display (LaTeX)
  - Variable table
  - Substitution step
  - Result highlighted
  - Each step shows citation or "model-derived" badge
- [ ] **F-217** Build Citation chip component: clickable, shows source preview on hover
- [ ] **F-218** Build Sources section at bottom of assistant message
- [ ] **F-219** Build OCR warning banner (when confidence is low)

### Streaming
- [ ] **F-220** Implement WebSocket chat connection
- [ ] **F-221** Handle streaming tokens: render incrementally
- [ ] **F-222** Show status indicators: "Searching...", "Reasoning...", "Calculating..."
- [ ] **F-223** Handle citation payload: render after text stream completes
- [ ] **F-224** Handle mindmap payload: render after citations
- [ ] **F-225** Handle error states: connection lost, timeout, server error
- [ ] **F-226** Implement reconnection logic with exponential backoff

### Clarification Flow
- [ ] **F-227** Detect clarifying question in assistant response
- [ ] **F-228** Display clarifying question with suggested quick-reply options (if any)

---

## Phase 3: PDF Viewer Panel

### PDF Rendering
- [ ] **F-301** Integrate PDF.js or react-pdf for rendering
- [ ] **F-302** Build PDFViewer: loads PDF from URL, renders pages
- [ ] **F-303** Build PageRenderer: single page with zoom controls
- [ ] **F-304** Build PDFToolbar: zoom in/out, fit width, page navigation, page number input
- [ ] **F-305** Implement smooth page scrolling and navigation

### Citation Highlighting
- [ ] **F-306** Build HighlightOverlay: transparent layer over PDF page
- [ ] **F-307** Render bounding box highlights at exact coordinates from citation data
- [ ] **F-308** Highlight style: semi-transparent yellow/blue rectangle over evidence region
- [ ] **F-309** On citation click in chat → PDF viewer scrolls to correct page + shows highlight
- [ ] **F-310** Support multiple highlights on the same page
- [ ] **F-311** Clear highlights when user navigates away or clicks "clear"

### PDF State
- [ ] **F-312** Track which PDF is currently loaded in viewer
- [ ] **F-313** PDF viewer does NOT auto-jump — only responds to citation clicks
- [ ] **F-314** Remember scroll position when switching between PDFs

---

## Phase 4: Mindmap Panel

### Mindmap Rendering
- [ ] **F-401** Integrate React Flow (or D3.js) for interactive graph rendering
- [ ] **F-402** Build MindmapCanvas: container above PDF viewer
- [ ] **F-403** Build MindmapNode component with different visual styles per node type:
  - Answer node (root): bold, highlighted
  - PDF source node: document icon + page number
  - Web source node: globe icon + domain name
  - User input node: user icon
  - Model reasoning node: brain icon, dashed border
  - Sub-conclusion node: intermediate styling
- [ ] **F-404** Build MindmapEdge: labeled connections ("formula from", "derived from", "validated by")
- [ ] **F-405** Auto-layout: tree/radial layout from root answer node

### Mindmap Interaction
- [ ] **F-406** Click PDF source node → opens PDF in viewer at cited page with highlight
- [ ] **F-407** Click web source node → opens URL in new browser tab
- [ ] **F-408** Hover on any node → shows preview tooltip with snippet
- [ ] **F-409** Zoom and pan on mindmap canvas
- [ ] **F-410** Mindmap updates automatically with each new answer
- [ ] **F-411** Collapsible: user can minimize the mindmap section

---

## Phase 5: Admin Interface

### Group Management
- [ ] **F-501** Build GroupManager: list groups, create, edit, delete
- [ ] **F-502** Group creation form: name, description
- [ ] **F-503** Group detail view: list documents + assigned users

### Document Management
- [ ] **F-504** Build DocumentUploader: drag-and-drop or file picker
- [ ] **F-505** Support multi-file upload
- [ ] **F-506** Show upload progress bar per file
- [ ] **F-507** Build IndexingStatus component: show pipeline status per document
  - Visual status: uploading → splitting → analyzing → extracting → embedding → ready
  - Failed state with error detail
- [ ] **F-508** Show document metadata: filename, page count, file size, upload date
- [ ] **F-509** Delete document button (with confirmation — "this will remove from search")
- [ ] **F-510** Replace document button (upload new version, re-index)

### User Assignment
- [ ] **F-511** Build UserAssignment panel within group detail
- [ ] **F-512** Searchable user list to assign to group
- [ ] **F-513** Show currently assigned users with remove button
- [ ] **F-514** Bulk assign/remove

### Admin Navigation
- [ ] **F-515** Admin sees "Manage" tab or button in the sidebar
- [ ] **F-516** Admin actions are inline in the same interface (not a separate page)
- [ ] **F-517** Non-admin users do not see admin controls

---

## Phase 6: State Management (Zustand Stores)

### Chat Store
- [ ] **F-601** `chatStore`: messages[], streaming state, active search mode
- [ ] **F-602** Actions: sendMessage, appendToken, setComplete, clearChat
- [ ] **F-603** Handle optimistic message display (user message appears immediately)

### Group Store
- [ ] **F-604** `groupStore`: groups[], activeGroup, loading states
- [ ] **F-605** Actions: fetchGroups, setActiveGroup, createGroup, deleteGroup
- [ ] **F-606** Persist activeGroup across page reloads (localStorage)

### Document Store
- [ ] **F-607** `documentStore`: documents[] for active group, selected documents (@ filter)
- [ ] **F-608** Actions: fetchDocuments, selectDocuments, uploadDocument, deleteDocument

### PDF Viewer Store
- [ ] **F-609** `pdfViewerStore`: currentPDF, currentPage, highlights[], zoom level
- [ ] **F-610** Actions: openPDF, goToPage, addHighlight, clearHighlights, setZoom

### Mindmap Store
- [ ] **F-611** `mindmapStore`: nodes[], edges[], layout
- [ ] **F-612** Actions: setMindmapData, clearMindmap

---

## Phase 7: Shared Components & Utilities

- [ ] **F-701** Build LaTeXRenderer: render LaTeX equations using KaTeX
- [ ] **F-702** Build MarkdownRenderer: render markdown with support for:
  - Code blocks
  - Tables
  - LaTeX inline and block
  - Citation chips embedded in markdown
- [ ] **F-703** Build ErrorBoundary: graceful error handling per panel
- [ ] **F-704** Build LoadingSpinner and skeleton loaders
- [ ] **F-705** Build toast notification system (upload success, errors, warnings)
- [ ] **F-706** Build confirmation dialog (for delete actions)

---

## Phase 8: Login & Auth

- [ ] **F-801** Build simple login page (internal tool — email/password or SSO)
- [ ] **F-802** Store auth token in httpOnly cookie or secure storage
- [ ] **F-803** Add auth header to all API requests
- [ ] **F-804** Redirect to login on 401
- [ ] **F-805** Show user name/role in sidebar

---

## Phase 9: Testing & Polish

- [ ] **F-901** Unit tests for Composer (# @ + triggers)
- [ ] **F-902** Unit tests for citation click → PDF viewer navigation
- [ ] **F-903** Unit tests for streaming message rendering
- [ ] **F-904** Integration test: full chat flow (send question → stream answer → show citations)
- [ ] **F-905** Integration test: admin upload → indexing status → document appears in @ list
- [ ] **F-906** Cross-browser testing (Chrome, Firefox, Safari)
- [ ] **F-907** Accessibility: keyboard navigation, screen reader support for chat
- [ ] **F-908** Performance: lazy load PDF pages, virtualize long message lists
- [ ] **F-909** Dark mode support (Tailwind dark variant)

---

## Dependency Order

```
Phase 0 → Phase 1 → Phase 6 (stores) → Phase 2 (chat) → Phase 3 (PDF)
                                          ↓
                                     Phase 7 (shared)
                                          ↓
                               Phase 4 (mindmap) + Phase 5 (admin)
                                          ↓
                                     Phase 8 (auth)
                                          ↓
                                     Phase 9 (testing)
```

Frontend depends on backend APIs being available from Phase 1 onward. Use mock data during development if backend is not ready.
