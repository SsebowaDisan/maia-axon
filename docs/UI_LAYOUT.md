# Maia Axon — UI Layout Specification

## Overview

Three-panel resizable layout with draggable dividers. All panels have adjustable widths. The right panel is collapsible when no PDF is open.

```
┌─────────────────┬─══─┬────────────────────────────┬─══─┬────────────────────────┐
│                 │ ↔  │                            │ ↔  │                        │
│  PANEL 1        │    │  PANEL 2                   │    │  PANEL 3               │
│  Conversation   │ D  │  Current Chat              │ D  │  Mindmap + PDF         │
│  History        │ R  │                            │ R  │                        │
│                 │ A  │                            │ A  │                        │
│  (resizable)    │ G  │  (resizable)               │ G  │  (resizable,           │
│                 │    │                            │    │   collapsible)         │
│                 │ ↔  │                            │ ↔  │                        │
└─────────────────┴─══─┴────────────────────────────┴─══─┴────────────────────────┘
                  ▲                                 ▲
            Drag handle                       Drag handle
```

### Default Panel Widths

| Panel | Default Width | Min Width | Max Width |
|-------|--------------|-----------|-----------|
| Panel 1 — History | 260px | 200px | 400px |
| Panel 2 — Chat | Fills remaining space | 400px | No max |
| Panel 3 — Mindmap + PDF | 420px | 300px | 700px |

### Resize Behavior

- **Drag handles** between panels (4px wide, visible on hover as a vertical bar)
- Cursor changes to `col-resize` on hover
- Panels respect min/max widths — dragging stops at boundaries
- Panel widths persist across page reloads (localStorage)
- Right panel can be fully collapsed (0px) via a toggle button or by dragging to minimum

### Responsive Behavior

| Viewport | Behavior |
|----------|----------|
| Desktop (>1200px) | All 3 panels visible, resizable |
| Tablet (768–1200px) | Panel 1 collapses to icon sidebar, Panel 3 opens as overlay |
| Mobile (<768px) | Tab-based navigation between panels |

---

## Panel 1 — Conversation History (Left Sidebar)

```
┌─────────────────────┐
│  ┌───────────────┐   │
│  │ 🔍 Search...  │   │
│  └───────────────┘   │
│                      │
│  ┌───────────────┐   │
│  │ + New Chat    │   │
│  └───────────────┘   │
│                      │
│  TODAY                │
│  ┌──────────────────┐ │
│  │ Cooling tower     │ │
│  │ heat rejection    │ │
│  │ ┌──────────────┐ │ │
│  │ │Cooling Towers│ │ │ ← group badge
│  │ └──────────────┘ │ │
│  └──────────────────┘ │
│  ┌──────────────────┐ │
│  │ Pump sizing       │ │
│  │ calculation       │ │
│  │ ┌──────────────┐ │ │
│  │ │ HVAC Systems │ │ │
│  │ └──────────────┘ │ │
│  └──────────────────┘ │
│                      │
│  YESTERDAY            │
│  ┌──────────────────┐ │
│  │ Flow rate...      │ │
│  └──────────────────┘ │
│                      │
│  LAST 7 DAYS          │
│  ┌──────────────────┐ │
│  │ Pipe friction...  │ │
│  └──────────────────┘ │
│                      │
│         ...          │
│                      │
│  ┌───────────────┐   │
│  │  Manage       │   │  ← admin only
│  └───────────────┘   │
│                      │
│  ┌───────────────┐   │
│  │ 👤 User Name  │   │
│  │    user role   │   │
│  └───────────────┘   │
└─────────────────────┘
```

### Elements

| Element | Behavior |
|---------|----------|
| Search | Filters conversations by title |
| + New Chat | Creates a new conversation (prompts for group selection) |
| Conversation item | Click to load. Shows title + group badge + timestamp |
| Conversation hover | Shows delete icon (click → confirmation dialog) |
| Date grouping | Today, Yesterday, Last 7 Days, Last 30 Days, Older |
| Manage button | Admin only. Opens admin panel inline (replaces history temporarily) |
| User info | Bottom. Shows name + role |

---

## Panel 2 — Current Chat (Center)

### Message Area

```
┌──────────────────────────────────────────────┐
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ 👤 User                                │  │
│  │                                        │  │
│  │ What is the heat rejection rate for a  │  │
│  │ cooling tower with flow rate 2.5 kg/s  │  │
│  │ and ΔT of 43K?                         │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ 🤖 Maia Axon           Library         │  │
│  │                                        │  │
│  │ ┌──────────────────────────────────┐   │  │
│  │ │ ⚠ Source from Manual.pdf p.34    │   │  │  ← OCR warning (when low confidence)
│  │ │   has low OCR confidence (72%)   │   │  │
│  │ └──────────────────────────────────┘   │  │
│  │                                        │  │
│  │ Using the formula from the Cooling     │  │
│  │ Tower Manual [¹], the heat rejection   │  │  ← inline citation chip
│  │ rate is calculated as follows:         │  │
│  │                                        │  │
│  │ ┌─ CALCULATION ──────────────────────┐ │  │
│  │ │                                    │ │  │
│  │ │ 📄 Formula: Q = m · cₚ · ΔT       │ │  │  ← from PDF (cited)
│  │ │    Source: Manual.pdf, p.34  [¹]   │ │  │
│  │ │                                    │ │  │
│  │ │ 📄 Variables:                      │ │  │
│  │ │    m  = 2.5 kg/s    (from user)    │ │  │
│  │ │    cₚ = 4.18 kJ/kg·K [¹]          │ │  │  ← from PDF (cited)
│  │ │    ΔT = 43 K         (from user)   │ │  │
│  │ │                                    │ │  │
│  │ │ 🧠 Substituting:                   │ │  │  ← model-derived (uncited)
│  │ │    Q = 2.5 × 4.18 × 43            │ │  │
│  │ │                                    │ │  │
│  │ │ ✅ Result: Q = 449.35 ≈ 450 kW     │ │  │
│  │ └────────────────────────────────────┘ │  │
│  │                                        │  │
│  │ The heat rejection rate is             │  │
│  │ approximately **450 kW**.              │  │
│  │                                        │  │
│  │ ┌─ SOURCES ──────────────────────────┐ │  │
│  │ │                                    │ │  │
│  │ │ [¹] Cooling_Tower_Manual.pdf, p.34 │ │  │  ← clickable → opens PDF
│  │ │     "Q = m · cₚ · ΔT where Q is   │ │  │
│  │ │      the heat rejection rate..."   │ │  │
│  │ │                                    │ │  │
│  │ │ [²] ASHRAE_Handbook.pdf, p.112     │ │  │
│  │ │     "Standard specific heat..."    │ │  │
│  │ │                                    │ │  │
│  │ └────────────────────────────────────┘ │  │
│  │                                        │  │
│  └────────────────────────────────────────┘  │
│                                              │
└──────────────────────────────────────────────┘
```

### Message Types

#### User Message
- Right-aligned or left-aligned (design choice)
- Plain text with the user's question

#### Assistant Message — Q&A
- Markdown rendered with LaTeX (KaTeX) support
- Inline citation chips: `[¹]` — clickable, hover shows preview
- Sources section at bottom
- OCR warning banner when source confidence is low

#### Assistant Message — Calculation
- Dedicated calculation block with:
  - Formula line (with citation)
  - Variable definitions (each tagged: "from PDF" or "from user")
  - Substitution step
  - Result highlighted
- Visual distinction:
  - `📄` icon = from PDF (grounded, cited)
  - `🧠` icon = model-derived (uncited)
  - `✅` icon = final result

#### Assistant Message — Clarification
- Question posed back to the user
- Optional quick-reply suggestions

### Citation Chip

```
┌──────┐
│ [¹]  │  ← small pill/badge inline in text
└──────┘

Hover → tooltip:
┌──────────────────────────────┐
│ Cooling_Tower_Manual.pdf     │
│ Page 34                      │
│ "Q = m · cₚ · ΔT where..."  │
└──────────────────────────────┘

Click → Panel 3 PDF viewer opens Manual.pdf at page 34 with highlight
```

### Streaming Indicators

```
┌────────────────────────────────┐
│ 🔍 Searching documents...      │  ← status: retrieving
│ 🧠 Reasoning...                │  ← status: reasoning
│ 🔢 Calculating...              │  ← status: calculating
│ ▊                              │  ← streaming cursor
└────────────────────────────────┘
```

---

### Composer (Bottom of Panel 2)

```
┌────────────────────────────────────────────────────────┐
│                                                        │
│  ┌──┐  ┌──────────────┐  ┌────────────┐   ┌────────┐  │
│  │+ │  │# Cool. Towers│  │@ Manual.pdf│   │Library │  │
│  └──┘  └──────────────┘  └────────────┘   └────────┘  │
│         ▲ group chip       ▲ doc chip      ▲ mode     │
│                                                        │
│  ┌──────────────────────────────────────────────┐ ┌──┐ │
│  │                                              │ │  │ │
│  │  Ask a question...                           │ │ ↑│ │
│  │                                              │ │  │ │
│  └──────────────────────────────────────────────┘ └──┘ │
│   ▲ auto-resize textarea                        ▲ send │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### Composer Controls

| Control | Trigger | What Opens |
|---------|---------|------------|
| `+` button | Click | Mode menu dropdown |
| `#` | Type `#` in input | Group selector dropdown |
| `@` | Type `@` in input | Document selector dropdown (within active group) |
| Enter | Press Enter | Send message |
| Shift+Enter | Press Shift+Enter | New line |

### `+` Menu (Mode Selector)

```
┌─────────────────────┐
│ 📚 Library          │  ← search group PDFs only
│ 🌐 Deep Search      │  ← search group PDFs + web
└─────────────────────┘
```

### `#` Group Selector

```
┌─────────────────────────────┐
│ 🔍 Search groups...         │
│                             │
│ Cooling Towers        12 📄 │  ← name + doc count
│ HVAC Systems           8 📄 │
│ Pump Engineering       5 📄 │
│ Piping Design         15 📄 │
└─────────────────────────────┘
```

### `@` Document Selector

```
┌─────────────────────────────────┐
│ 🔍 Search in Cooling Towers...  │
│                                 │
│ ☑ All documents                 │  ← default: search all
│                                 │
│ ☐ Cooling_Tower_Manual.pdf      │  ← toggle to narrow
│ ☐ ASHRAE_Handbook_Ch38.pdf      │
│ ☐ CTI_Performance_Guide.pdf     │
│ ☐ Vendor_Specs_2024.pdf         │
└─────────────────────────────────┘
```

### Composer States

| State | Behavior |
|-------|----------|
| No group selected | Composer disabled. Placeholder: "Select a group with # to start" |
| Group selected, no docs narrowed | Searches all PDFs in group |
| Group + specific docs selected | Searches only selected PDFs |
| Streaming in progress | Send button disabled, shows stop button |

---

## Panel 3 — Mindmap + PDF Renderer (Right)

### Layout (Top/Bottom Split)

```
┌──────────────────────────┐
│  MINDMAP                 │  ← top section (resizable height)
│                          │
│  (interactive graph)     │
│                          │
│  ┌─[─]──────────────┐   │  ← collapse/minimize toggle
├──┤                   ├───│  ← vertical drag handle
│  └───────────────────┘   │
│  PDF RENDERER            │  ← bottom section
│                          │
│  ┌────────────────────┐  │
│  │ toolbar             │  │
│  ├────────────────────┤  │
│  │                    │  │
│  │  (PDF page)        │  │
│  │                    │  │
│  │  ┌──────────────┐  │  │
│  │  │▒▒▒▒▒▒▒▒▒▒▒▒▒│  │  │  ← citation highlight (yellow overlay)
│  │  └──────────────┘  │  │
│  │                    │  │
│  └────────────────────┘  │
└──────────────────────────┘
```

### Mindmap Section

```
                    ┌─────────────────────┐
                    │  Heat rejection     │
                    │  rate = 450 kW      │  ← root: answer node (bold)
                    └──────┬──────────────┘
                           │
            ┌──────────────┼──────────────────┐
            │              │                  │
   ┌────────▼────────┐  ┌─▼──────────┐  ┌───▼──────────┐
   │ 📄 Manual.pdf   │  │ 📄 ASHRAE  │  │ 🧠 Model     │
   │    p.34         │  │    p.112   │  │   reasoning  │
   │                 │  │            │  │   (uncited)  │
   │ Formula source  │  │ cₚ value   │  │ Substitution │
   └─────────────────┘  └────────────┘  └──────────────┘
    ▲ click → opens       ▲ click → opens    (not clickable)
    PDF at p.34            PDF at p.112
```

#### Node Types

| Node | Visual Style | Click Action |
|------|-------------|--------------|
| Answer | Root, bold border, highlighted | None |
| PDF Source | Document icon, page number, solid border | Opens PDF at page + highlights evidence |
| Web Source | Globe icon, domain name, solid border | Opens URL in new browser tab |
| User Input | User icon, light border | None |
| Model Reasoning | Brain icon, dashed border | None |
| Sub-conclusion | Intermediate node, subtle border | Expands detail tooltip |

#### Mindmap Interactions

| Action | Behavior |
|--------|----------|
| Click PDF node | Opens PDF in viewer below, scrolls to page, highlights |
| Click web node | Opens URL in new tab |
| Hover any node | Shows tooltip with snippet/detail |
| Scroll/pinch | Zoom in/out |
| Drag canvas | Pan |
| Collapse button | Minimizes mindmap to a thin bar |

#### Mindmap Updates

- Renders automatically after each assistant response
- Clears and rebuilds for each new answer
- Empty state: "Ask a question to see how the answer is constructed"

---

### PDF Renderer Section

#### Toolbar

```
┌────────────────────────────────────────────────────────┐
│  Cooling_Tower_Manual.pdf                              │
│                                                        │
│  [−] [+] [Fit]    ◀ Page 34 of 128 ▶    [✕ Close]     │
└────────────────────────────────────────────────────────┘
```

| Control | Action |
|---------|--------|
| `−` / `+` | Zoom out / in |
| `Fit` | Fit page to panel width |
| `◀` / `▶` | Previous / next page |
| Page number | Editable — type a number to jump |
| `✕ Close` | Closes the PDF viewer |
| Document name | Shows which PDF is loaded |

#### Citation Highlighting

```
┌────────────────────────────────────────┐
│                                        │
│  The heat rejection rate is            │
│  calculated using the following        │
│  formula:                              │
│                                        │
│  ┌────────────────────────────────┐    │
│  │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│    │  ← highlighted region
│  │▒▒ Q = m · cₚ · ΔT            ▒│    │     (semi-transparent yellow)
│  │▒▒                             ▒│    │
│  │▒▒ where Q is the heat        ▒│    │
│  │▒▒ rejection rate in kW       ▒│    │
│  │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│    │
│  └────────────────────────────────┘    │
│                                        │
│  For a typical cooling tower...        │
│                                        │
└────────────────────────────────────────┘
```

#### PDF Viewer Behavior

| Rule | Behavior |
|------|----------|
| Auto-jump | **NO** — viewer does NOT auto-navigate. Only responds to user clicks |
| Citation click (in chat) | Viewer opens PDF, scrolls to page, shows highlight |
| Mindmap node click | Same as citation click |
| Multiple highlights | Supported on same page |
| Switch PDFs | Remembers scroll position per PDF |
| Clear highlights | When user navigates away manually or clicks "clear" |
| Collapse panel | Right panel can be fully collapsed when no PDF is open |

#### Empty State

```
┌────────────────────────────────────────┐
│                                        │
│                                        │
│        📄                              │
│                                        │
│   Click a citation or mindmap node     │
│   to view the source document          │
│                                        │
│                                        │
└────────────────────────────────────────┘
```

---

## Admin Interface (Inline in Panel 1)

When admin clicks **Manage**, Panel 1 content is replaced with the admin view.
A back arrow returns to conversation history.

### Admin Navigation

```
┌─────────────────────┐
│  ← Back to chats    │
│                     │
│  ┌───────────────┐  │
│  │ Groups        │  │  ← tab
│  │ Documents     │  │  ← tab
│  │ Users         │  │  ← tab
│  └───────────────┘  │
└─────────────────────┘
```

### Groups Tab

```
┌─────────────────────────┐
│  Groups                 │
│                         │
│  ┌───────────────────┐  │
│  │ + Create Group    │  │
│  └───────────────────┘  │
│                         │
│  ┌───────────────────┐  │
│  │ Cooling Towers    │  │
│  │ 12 docs · 5 users │  │
│  │ [Edit] [Delete]   │  │
│  └───────────────────┘  │
│  ┌───────────────────┐  │
│  │ HVAC Systems      │  │
│  │  8 docs · 3 users │  │
│  │ [Edit] [Delete]   │  │
│  └───────────────────┘  │
└─────────────────────────┘
```

### Documents Tab (within a selected group)

```
┌──────────────────────────────┐
│  Cooling Towers › Documents  │
│                              │
│  ┌────────────────────────┐  │
│  │ 📎 Drop PDFs here      │  │  ← drag-and-drop zone
│  │    or click to browse  │  │
│  └────────────────────────┘  │
│                              │
│  ┌────────────────────────┐  │
│  │ Cooling_Tower_Manual   │  │
│  │ 4.2 MB · 128 pages    │  │
│  │ ● Ready               │  │  ← green dot
│  │ [Replace] [Delete]    │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ Vendor_Specs_2024      │  │
│  │ 1.8 MB · 45 pages     │  │
│  │ ◐ Analyzing (GLM-OCR) │  │  ← spinning indicator
│  │ ████████░░░░ 65%       │  │  ← progress bar
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ Old_Handbook_Scan      │  │
│  │ 12 MB · 300 pages     │  │
│  │ ✕ Failed               │  │  ← red dot
│  │ "OCR timeout on p.45" │  │  ← error detail
│  │ [Retry] [Delete]      │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
```

#### Indexing Status Indicators

| Status | Visual |
|--------|--------|
| Uploading | ↑ Upload icon + progress bar |
| Splitting | ◐ Spinner + "Splitting pages..." |
| GLM-OCR | ◐ Spinner + "Analyzing (GLM-OCR)..." |
| Captioning | ◐ Spinner + "Processing figures..." |
| Embedding | ◐ Spinner + "Generating embeddings..." |
| Ready | ● Green dot + "Ready" |
| Failed | ✕ Red dot + error message + [Retry] button |

### Users Tab (within a selected group)

```
┌──────────────────────────────┐
│  Cooling Towers › Users      │
│                              │
│  ┌────────────────────────┐  │
│  │ + Assign User          │  │
│  └────────────────────────┘  │
│                              │
│  ┌────────────────────────┐  │
│  │ John Smith             │  │
│  │ john@company.com       │  │
│  │               [Remove] │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ Sarah Johnson          │  │
│  │ sarah@company.com      │  │
│  │               [Remove] │  │
│  └────────────────────────┘  │
│                              │
│  Assign User:                │
│  ┌────────────────────────┐  │
│  │ 🔍 Search users...     │  │
│  │                        │  │
│  │ Mike Davis             │  │
│  │ Lisa Chen              │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
```

---

## Login Page

Simple internal-tool login. No public registration.

```
┌─────────────────────────────────────┐
│                                     │
│           Maia Axon                 │
│                                     │
│  ┌───────────────────────────────┐  │
│  │ Email                         │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │ Password                      │  │
│  └───────────────────────────────┘  │
│                                     │
│  ┌───────────────────────────────┐  │
│  │         Sign In               │  │
│  └───────────────────────────────┘  │
│                                     │
└─────────────────────────────────────┘
```

---

## Color & Theming

| Element | Light | Dark |
|---------|-------|------|
| Background | White | Dark gray |
| Panel borders | Light gray | Dark border |
| Citation chip | Blue pill | Light blue pill |
| PDF highlight | Semi-transparent yellow | Semi-transparent amber |
| Grounded step (from PDF) | Left border blue | Left border blue |
| Uncited step (model) | Left border dashed gray | Left border dashed gray |
| Warning banner | Light amber bg | Dark amber bg |
| Ready status | Green | Green |
| Failed status | Red | Red |
| Processing status | Blue spinner | Blue spinner |

Dark mode supported via Tailwind CSS `dark:` variant.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift + Enter` | New line in composer |
| `Escape` | Close PDF viewer / close dropdown |
| `Ctrl/Cmd + K` | Focus search in sidebar |
| `Ctrl/Cmd + N` | New chat |
| `Ctrl/Cmd + /` | Toggle right panel |

---

## Technology

| Component | Library |
|-----------|---------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS + shadcn/ui |
| State | Zustand |
| PDF viewer | react-pdf / PDF.js + custom highlight overlay |
| Mindmap | React Flow |
| Markdown | react-markdown + KaTeX |
| Resize panels | react-resizable-panels |
| File upload | react-dropzone |
| WebSocket | Native WebSocket API |
