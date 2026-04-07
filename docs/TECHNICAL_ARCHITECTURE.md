# Maia Axon — Technical Architecture

## System Overview

Maia Axon is a group-scoped multimodal document reasoning system. It ingests scanned, image-heavy, formula-heavy PDFs, indexes them for retrieval, and answers user questions with grounded citations and step-by-step calculations.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLIENT (Next.js)                            │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐  │
│  │  Conversation │  │   Current Chat   │  │  PDF Renderer +       │  │
│  │  History      │  │   + Composer     │  │  Mindmap              │  │
│  │  Panel        │  │   (# @ +)        │  │  Panel                │  │
│  └──────────────┘  └──────────────────┘  └───────────────────────┘  │
└────────────────────────────┬────────────────────────────────────────┘
                             │ WebSocket + REST
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        API GATEWAY (FastAPI)                         │
│  Auth · Rate Limiting · Request Routing                             │
└──────┬──────────┬──────────┬──────────┬──────────┬─────────────────┘
       │          │          │          │          │
       ▼          ▼          ▼          ▼          ▼
  ┌─────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
  │ Ingest  │ │ Retriev│ │ Answer │ │ Admin  │ │ Mindmap  │
  │ Service │ │ Service│ │ Engine │ │ Service│ │ Service  │
  └────┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └────┬─────┘
       │          │          │          │          │
       ▼          ▼          ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        DATA LAYER                                    │
│  PostgreSQL · Vector DB (pgvector) · Object Storage (S3/MinIO)      │
│  Redis (cache + queue) · Elasticsearch (optional full-text)          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. Ingestion Pipeline

This is the most critical system. If ingestion is weak, everything downstream fails.

### 1.1 Pipeline Flow

GLM-OCR (0.9B param multimodal model by Zhipu AI) replaces the traditional multi-tool
ingestion chain. It handles layout detection (25 region types via PP-DocLayoutV3),
text OCR, formula recognition (inline + display → LaTeX), and table extraction — all
in one pass, with bounding boxes and structured JSON output. #1 on OmniDocBench V1.5
(score 94.62). Apache 2.0 code, MIT model weights.

```
PDF Upload
    │
    ▼
┌──────────────────┐
│ File Validation   │  Validate format, size, corruption
│ & Storage         │  Store original in S3/MinIO
└────────┬─────────┘
         ▼
┌──────────────────┐
│ Page Splitting    │  Split PDF into individual page images
│ (PyMuPDF)         │  Store each page as high-res PNG
└────────┬─────────┘
         ▼
┌──────────────────────────────────────────────────────┐
│                    GLM-OCR                             │
│                                                       │
│  ┌─────────────────────┐                              │
│  │ PP-DocLayoutV3       │  Detect 25 region types:    │
│  │ Layout Detection     │  text, paragraph_title,     │
│  │                      │  display_formula,           │
│  │                      │  inline_formula, table,     │
│  │                      │  figure, chart, algorithm,  │
│  │                      │  header, footer, etc.       │
│  │                      │  Output: bounding boxes     │
│  └──────────┬──────────┘                              │
│             ▼                                         │
│  ┌─────────────────────┐                              │
│  │ Parallel Region      │  Up to 32 concurrent        │
│  │ Recognition          │  workers per page:          │
│  │                      │                             │
│  │  Text regions     →  │  "Text Recognition:"        │
│  │  Formula regions  →  │  "Formula Recognition:"     │
│  │  Table regions    →  │  "Table Recognition:"       │
│  │                      │                             │
│  │  Output: Markdown +  │  Structured JSON with       │
│  │  region coordinates  │  bounding boxes per region  │
│  └──────────┬──────────┘                              │
│             ▼                                         │
│  Post-processing:                                     │
│  - Merge formula numbers into formula blocks          │
│  - Merge adjacent text blocks                         │
│  - Format bullet points                               │
└─────────────────────┬────────────────────────────────┘
                      ▼
┌──────────────────────────────┐
│ Figure Captioner              │  Only for image/chart regions
│ (Claude Vision)               │  that GLM-OCR skips
│                               │  Generate text descriptions
│                               │  for retrieval indexing
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Variable Extractor            │  Post-process equation LaTeX:
│ (LLM)                        │  map variables to definitions
│                               │  using surrounding text context
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Structured Document Store     │  Combine GLM-OCR JSON output
│                               │  + figure captions + variable
│                               │  mappings into page records
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Chunking & Embedding          │  Create retrieval units (1.3)
│                               │  Generate embeddings
│                               │  Store in vector DB
└──────────────────────────────┘
```

### 1.2 Page-Level Document Model

Every page produces a structured record. The `regions` array is populated directly
from GLM-OCR's JSON output (bounding boxes + recognized content), enriched with
figure captions from Claude Vision and variable mappings from the LLM post-processor.

```json
{
  "document_id": "uuid",
  "page_number": 12,
  "page_image_url": "s3://bucket/doc_id/pages/12.png",
  "markdown": "## Heat Rejection\n\nThe heat rejection rate is calculated using...\n\n$$Q = m \\cdot c_p \\cdot \\Delta T$$",
  "ocr_text": "full page text with reading order (from GLM-OCR markdown)",
  "regions": [
    {
      "type": "text",
      "glm_label": "paragraph_title",
      "bbox": [x1, y1, x2, y2],
      "content": "Heat Rejection"
    },
    {
      "type": "text",
      "glm_label": "text",
      "bbox": [x1, y1, x2, y2],
      "content": "The heat rejection rate is calculated using..."
    },
    {
      "type": "equation",
      "glm_label": "display_formula",
      "bbox": [x1, y1, x2, y2],
      "latex": "Q = m \\cdot c_p \\cdot \\Delta T",
      "variables": {
        "Q": "heat rejection rate (kW)",
        "m": "mass flow rate (kg/s)",
        "c_p": "specific heat capacity (kJ/kg·K)",
        "ΔT": "temperature difference (K)"
      }
    },
    {
      "type": "table",
      "glm_label": "table",
      "bbox": [x1, y1, x2, y2],
      "content_markdown": "| Parameter | Value | Unit |\n|---|---|---|\n| Flow rate | 2.5 | kg/s |",
      "headers": ["Parameter", "Value", "Unit"],
      "rows": [["Flow rate", "2.5", "kg/s"]]
    },
    {
      "type": "figure",
      "glm_label": "image",
      "bbox": [x1, y1, x2, y2],
      "caption": "Figure 4.2: Cooling tower performance curve",
      "description": "Graph showing relationship between... (from Claude Vision)"
    }
  ],
  "metadata": {
    "chapter": "4",
    "section": "Heat Rejection",
    "document_title": "Cooling Tower Design Manual"
  }
}
```

### 1.3 Chunking Strategy

**Do not use fixed-size token chunks.** Use structural units:

| Chunk Type | Unit | When |
|-----------|------|------|
| Section chunk | Full section text + equations | Default for text-heavy sections |
| Page chunk | Entire page content | Fallback when structure is unclear |
| Equation chunk | Equation + surrounding context (2 paragraphs) | For formula retrieval |
| Table chunk | Table + caption + column headers | For data retrieval |
| Figure chunk | Figure description + caption | For diagram retrieval |

Each chunk stores:
- `chunk_id`
- `document_id`
- `page_number`
- `chunk_type`
- `content_text` (for embedding)
- `bbox_references` (list of bounding boxes on the page — for citation highlighting)
- `embedding` (vector)

### 1.4 Technology Choices for Ingestion

| Component | Technology | Notes |
|-----------|-----------|-------|
| PDF to images | PyMuPDF (`fitz`) | Fast, reliable page splitting |
| Layout + OCR + Formulas + Tables | **GLM-OCR** (`pip install glmocr`) | Single system replaces 4 separate tools. 25 region types, bounding boxes, LaTeX output, Markdown + JSON. SOTA on OmniDocBench V1.5 |
| GLM-OCR deployment | Zhipu MaaS API (cloud) or self-hosted via vLLM/SGLang/Ollama | Cloud for MVP, self-hosted for production scale |
| Figure captioning | OpenAI GPT-4o Vision | Only for `image`/`chart` regions that GLM-OCR skips |
| Variable extraction | OpenAI GPT-4o | Post-process: map LaTeX variables to definitions using surrounding text |
| Embeddings | `text-embedding-3-large` (OpenAI) or Cohere embed v3 | sentence-transformers as fallback |

### 1.5 Indexing Status

Each document tracks its processing state:

```
UPLOADING → SPLITTING → GLM_OCR → CAPTIONING → EMBEDDING → READY
                                                              │
                                                         ──→ FAILED (with error detail)
```

Admins and users see this status per document.

---

## 2. Retrieval Service

### 2.1 Library Search (Group Only)

```
User Question
    │
    ▼
┌──────────────────┐
│ Query Processing  │  Detect intent: Q&A vs calculation
│                   │  Extract key terms, formulas, units
└────────┬─────────┘
         ▼
┌──────────────────┐
│ Scope Filter      │  Filter to: active group
│                   │  If @ used: filter to specific PDFs
└────────┬─────────┘
         ▼
┌──────────────────────────────────────┐
│ Hybrid Retrieval                      │
│                                       │
│  ┌─────────────┐  ┌────────────────┐  │
│  │ Vector       │  │ Keyword/BM25   │  │
│  │ Search       │  │ Search         │  │
│  │ (semantic)   │  │ (exact match)  │  │
│  └──────┬──────┘  └───────┬────────┘  │
│         │                  │           │
│         └──────┬───────────┘           │
│                ▼                       │
│  ┌─────────────────────────────┐      │
│  │ Reciprocal Rank Fusion      │      │
│  │ + Reranking (Cohere/Cross   │      │
│  │   Encoder)                  │      │
│  └─────────────────────────────┘      │
└───────────────────┬──────────────────┘
                    ▼
         Top-K chunks with scores
         + page images for top results
         + bounding boxes for citations
```

### 2.2 Deep Search (Group + Web)

```
User Question
    │
    ├──────────────────────────────┐
    ▼                              ▼
┌──────────────┐          ┌──────────────┐
│ Library       │          │ Web Search   │
│ Search        │          │ (Tavily /    │
│ (same as 2.1) │          │  Brave /     │
│               │          │  Serper)     │
└──────┬───────┘          └──────┬───────┘
       │                         │
       │                         ▼
       │                  ┌──────────────┐
       │                  │ Web Page     │
       │                  │ Scraping &   │
       │                  │ Extraction   │
       │                  └──────┬───────┘
       │                         │
       └────────┬────────────────┘
                ▼
       ┌──────────────────┐
       │ Source Merging &  │
       │ Deduplication     │
       │ + Reranking       │
       └────────┬─────────┘
                ▼
       Unified ranked results
       (PDF chunks + web excerpts)
       Each tagged with source type
```

### 2.3 Retrieval Output Format

```json
{
  "results": [
    {
      "source_type": "pdf",
      "document_id": "uuid",
      "document_name": "Cooling_Tower_Manual.pdf",
      "page_number": 34,
      "chunk_type": "equation",
      "content": "Q = m · cp · ΔT",
      "latex": "Q = m \\cdot c_p \\cdot \\Delta T",
      "bbox_references": [[120, 340, 480, 390]],
      "relevance_score": 0.94,
      "ocr_confidence": 0.91
    },
    {
      "source_type": "web",
      "url": "https://engineeringtoolbox.com/cooling-tower",
      "title": "Cooling Tower Heat Rejection",
      "content": "The standard method for...",
      "relevance_score": 0.82
    }
  ]
}
```

---

## 3. Answer Engine

### 3.1 Architecture

```
Retrieved Sources + User Question + Conversation History
    │
    ▼
┌──────────────────────────────────────────┐
│            ORCHESTRATOR (LangGraph)        │
│                                            │
│  ┌──────────┐                              │
│  │ Classify  │ → Q&A / Calculation /       │
│  │ Intent    │   Ambiguous                 │
│  └─────┬────┘                              │
│        │                                   │
│   ┌────┴─────┬──────────────┐              │
│   ▼          ▼              ▼              │
│ ┌──────┐ ┌──────────┐ ┌──────────┐        │
│ │ Q&A  │ │ Calcul-  │ │ Clarify  │        │
│ │ Agent│ │ ation    │ │ Agent    │        │
│ │      │ │ Agent    │ │          │        │
│ └──┬───┘ └────┬─────┘ └────┬─────┘        │
│    │          │             │              │
│    │     ┌────▼─────┐      │              │
│    │     │ Code     │      │              │
│    │     │ Executor │      │              │
│    │     │ (Python  │      │              │
│    │     │ sandbox) │      │              │
│    │     └────┬─────┘      │              │
│    │          │             │              │
│    └────┬─────┴─────────────┘              │
│         ▼                                  │
│  ┌─────────────────┐                       │
│  │ Response Builder │                      │
│  │ + Citation       │                      │
│  │   Mapper         │                      │
│  └────────┬────────┘                       │
│           ▼                                │
│  ┌─────────────────┐                       │
│  │ Mindmap          │                      │
│  │ Generator        │                      │
│  └─────────────────┘                       │
└──────────────────────────────────────────┘
```

### 3.2 Q&A Agent

- Receives retrieved chunks + page images
- Generates answer grounded in sources
- Attaches inline citations: `[Source: Cooling_Tower_Manual.pdf, p.34]`
- Separates cited content from model-derived reasoning
- If OCR confidence is low on a source, adds warning

### 3.3 Calculation Agent

Step-by-step flow:

```
1. Extract relevant formulas from retrieved chunks
2. If multiple methods found → present all, note differences
3. Identify required variables
4. Match variables to user-provided values
5. If missing values → ask user (return clarifying question)
6. Auto-convert units if needed
7. Execute calculation in Python sandbox (not LLM arithmetic)
8. Format step-by-step:
   a. Formula (with citation)
   b. Variable definitions (with citations where from docs)
   c. Substitution
   d. Computation steps
   e. Final answer with units
9. Each step tagged: "from PDF" or "model-derived"
```

**Python Sandbox**: Isolated execution environment for calculations.
- No network access
- No filesystem access
- Timeout: 30 seconds
- Libraries: `numpy`, `scipy`, `sympy`, `pint` (units)

### 3.4 Clarification Agent

Triggered when:
- Question is ambiguous
- Multiple valid interpretations exist
- Missing critical information

Returns a structured clarifying question before any answer attempt.

### 3.5 Response Format

```json
{
  "answer": {
    "text": "The heat rejection rate is **450 kW**.",
    "sections": [
      {
        "type": "explanation",
        "content": "Using the formula from the Cooling Tower Manual...",
        "grounded": true
      },
      {
        "type": "calculation",
        "steps": [
          {
            "step": "Formula: Q = m · cp · ΔT",
            "citation": { "document_id": "uuid", "page": 34, "bbox": [...] },
            "grounded": true
          },
          {
            "step": "Substituting: Q = 2.5 × 4.18 × 43",
            "citation": null,
            "grounded": false
          },
          {
            "step": "Q = 449.35 ≈ 450 kW",
            "citation": null,
            "grounded": false
          }
        ]
      }
    ],
    "citations": [
      {
        "id": "cite-1",
        "source_type": "pdf",
        "document_id": "uuid",
        "document_name": "Cooling_Tower_Manual.pdf",
        "page": 34,
        "bbox": [120, 340, 480, 390],
        "snippet": "Q = m · cp · ΔT"
      },
      {
        "id": "cite-2",
        "source_type": "web",
        "url": "https://...",
        "title": "...",
        "snippet": "..."
      }
    ],
    "mindmap": {
      "root": "Heat rejection rate = 450 kW",
      "branches": [
        {
          "label": "Formula source",
          "source": "cite-1",
          "children": []
        },
        {
          "label": "User input: m=2.5, ΔT=43",
          "source": null,
          "children": []
        }
      ]
    },
    "warnings": [
      "OCR confidence on page 34 is 0.85 — verify the formula visually"
    ]
  }
}
```

---

## 4. Mindmap Service

### 4.1 How It Works

After the answer is generated, the mindmap service traces the provenance of each part of the answer:

```
Answer Engine Output (with citations)
    │
    ▼
┌──────────────────────────┐
│ Provenance Tracer         │
│                           │
│ For each answer section:  │
│  - Which sources used?    │
│  - What was extracted?    │
│  - How did sources        │
│    combine?               │
└───────────┬──────────────┘
            ▼
┌──────────────────────────┐
│ Graph Builder             │
│                           │
│ Nodes: answer, sources,   │
│        sub-conclusions    │
│ Edges: "derived from",    │
│        "formula from",    │
│        "validated by"     │
└───────────┬──────────────┘
            ▼
┌──────────────────────────┐
│ Layout Engine             │
│ (D3.js / React Flow)     │
│                           │
│ Interactive, clickable    │
│ nodes → open source       │
└──────────────────────────┘
```

### 4.2 Mindmap Node Types

| Node Type | Visual | Click Action |
|-----------|--------|--------------|
| Answer | Root node, highlighted | None |
| PDF Source | Document icon + page number | Opens PDF at page, highlights bbox |
| Web Source | Globe icon + domain | Opens URL in new tab |
| User Input | User icon | None |
| Model Reasoning | Brain icon, dashed border | None |
| Sub-conclusion | Intermediate node | Expands details |

---

## 5. Data Layer

### 5.1 PostgreSQL Schema (Core Tables)

```sql
-- Users & Auth
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR NOT NULL UNIQUE,
    name VARCHAR NOT NULL,
    role VARCHAR NOT NULL CHECK (role IN ('admin', 'user')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Groups
CREATE TABLE groups (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL,
    description TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Group-User assignments
CREATE TABLE group_assignments (
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES users(id),
    assigned_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

-- Documents
CREATE TABLE documents (
    id UUID PRIMARY KEY,
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    filename VARCHAR NOT NULL,
    file_url VARCHAR NOT NULL,
    file_size_bytes BIGINT,
    page_count INTEGER,
    status VARCHAR NOT NULL DEFAULT 'uploading'
        CHECK (status IN ('uploading','splitting','glm_ocr','captioning','embedding','ready','failed')),
    error_detail TEXT,
    uploaded_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Pages (one per PDF page)
CREATE TABLE pages (
    id UUID PRIMARY KEY,
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    image_url VARCHAR NOT NULL,
    ocr_text TEXT,
    ocr_confidence FLOAT,
    regions JSONB,  -- array of region objects with bbox, type, content
    created_at TIMESTAMP DEFAULT NOW()
);

-- Chunks (retrieval units)
CREATE TABLE chunks (
    id UUID PRIMARY KEY,
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    chunk_type VARCHAR NOT NULL
        CHECK (chunk_type IN ('section','page','equation','table','figure')),
    content_text TEXT NOT NULL,
    latex TEXT,
    variables JSONB,
    bbox_references JSONB,  -- array of [x1,y1,x2,y2]
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Vector embeddings (pgvector)
CREATE TABLE chunk_embeddings (
    chunk_id UUID PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(3072)  -- dimension depends on model
);

CREATE INDEX idx_chunk_embeddings_ivfflat
    ON chunk_embeddings USING ivfflat (embedding vector_cosine_ops);

-- Conversations
CREATE TABLE conversations (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    group_id UUID REFERENCES groups(id),
    title VARCHAR,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Messages
CREATE TABLE messages (
    id UUID PRIMARY KEY,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    citations JSONB,
    mindmap JSONB,
    search_mode VARCHAR CHECK (search_mode IN ('library', 'deep_search')),
    created_at TIMESTAMP DEFAULT NOW()
);
```

### 5.2 Object Storage (S3/MinIO)

```
bucket/
├── documents/
│   └── {document_id}/
│       ├── original.pdf
│       └── pages/
│           ├── 1.png
│           ├── 2.png
│           └── ...
```

### 5.3 Redis

- **Job queue**: Ingestion pipeline tasks (Bull/Celery)
- **Cache**: Recent query results, active group context per user
- **Session**: Active conversation state, streaming tokens

---

## 6. Real-Time Communication

### 6.1 WebSocket for Chat Streaming

```
Client                          Server
  │                                │
  │── WS Connect ─────────────────│
  │                                │
  │── { type: "query",            │
  │     group_id: "...",          │
  │     document_ids: [...],      │  (optional, from @ selection)
  │     mode: "library",          │
  │     message: "..." }          │
  │                                │
  │◄─ { type: "status",           │
  │     status: "retrieving" } ───│
  │                                │
  │◄─ { type: "status",           │
  │     status: "reasoning" } ────│
  │                                │
  │◄─ { type: "token",            │
  │     content: "The" } ─────────│
  │◄─ { type: "token",            │
  │     content: " heat" } ───────│
  │     ...                        │
  │                                │
  │◄─ { type: "citations",        │
  │     data: [...] } ────────────│
  │                                │
  │◄─ { type: "mindmap",          │
  │     data: {...} } ────────────│
  │                                │
  │◄─ { type: "done" } ──────────│
```

---

## 7. Technology Stack

### Backend
| Component | Technology |
|-----------|-----------|
| API Framework | FastAPI (Python) |
| Task Queue | Celery + Redis |
| LLM Orchestration | LangGraph |
| LLM Provider | OpenAI GPT-4o (chat, vision, embeddings) |
| Vector DB | PostgreSQL + pgvector |
| Full-text Search | PostgreSQL tsvector (or Elasticsearch if scale demands) |
| Object Storage | MinIO (self-hosted) or AWS S3 |
| Database | PostgreSQL 16 |
| Cache/Queue | Redis |
| PDF Processing | PyMuPDF |
| Document Intelligence | **GLM-OCR** (`glmocr`) — layout, OCR, formulas, tables in one pass |
| Figure Captioning | OpenAI GPT-4o Vision (for image/chart regions only) |
| Code Execution | Sandboxed Python (RestrictedPython or Docker containers) |
| Web Search | Tavily API |
| Reranking | Cohere Rerank or cross-encoder |
| WebSocket | FastAPI WebSocket |

### Frontend
| Component | Technology |
|-----------|-----------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| UI Library | Tailwind CSS + shadcn/ui |
| State Management | Zustand |
| PDF Viewer | react-pdf / PDF.js with custom highlight overlay |
| Mindmap | React Flow or D3.js |
| WebSocket Client | Native WebSocket API |
| Markdown Rendering | react-markdown + KaTeX (for LaTeX) |
| File Upload | react-dropzone |

### Infrastructure
| Component | Technology |
|-----------|-----------|
| Containerization | Docker + Docker Compose |
| Deployment | AWS (ECS/EKS) or self-hosted |
| CI/CD | GitHub Actions |
| Monitoring | Prometheus + Grafana |
| Logging | Structured JSON logs + ELK or Loki |

---

## 8. Key Architecture Decisions

### 8.1 Why page-level storage, not just text chunks?
Because citations need bounding boxes to highlight evidence in the PDF renderer. Text-only chunks lose spatial information.

### 8.2 Why a Python sandbox for calculations?
LLMs are unreliable at arithmetic. A Python sandbox with `numpy`/`scipy`/`sympy` gives exact results. The LLM's job is to set up the calculation, not execute it.

### 8.3 Why hybrid retrieval (vector + keyword)?
Formula symbols and variable names are often missed by pure semantic search. BM25 catches exact symbol matches that embeddings miss.

### 8.4 Why LangGraph for orchestration?
The answer flow has branching logic (Q&A vs calculation vs clarification), tool use (code execution, web search), and multi-step reasoning. LangGraph handles stateful agent workflows well.

### 8.5 Why GLM-OCR instead of separate OCR/layout/formula tools?
GLM-OCR (Zhipu AI, 0.9B params) replaces 4 separate tools (layout detector, OCR engine, formula extractor, table extractor) with a single unified system. It outputs structured JSON with bounding boxes, LaTeX formulas, and table data — exactly what we need for citation highlighting. It scores #1 on OmniDocBench V1.5 (94.62), handles 25 document region types, and processes regions in parallel (up to 32 workers). This dramatically simplifies the ingestion pipeline, reduces integration complexity, and improves accuracy over chaining separate tools. OpenAI GPT-4o Vision is used only as a supplement for figure/chart captioning (image regions that GLM-OCR intentionally skips).

### 8.6 Why not process all PDFs at query time?
A group might contain 50 PDFs with 5000+ pages. Reading all at query time would be slow (minutes), expensive (millions of tokens), and unreliable. Pre-indexing + retrieval is the only viable approach.

---

## 9. Security Considerations

- **Sandboxed code execution**: No network, no filesystem, timeout enforced
- **Group isolation**: Users only see groups assigned to them; queries only search assigned groups
- **File validation**: Check MIME type, scan for malicious content before ingestion
- **Rate limiting**: Per-user query limits to prevent abuse
- **Audit logging**: Track who queried what, when, and which documents were accessed
