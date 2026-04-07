# Backend Tasks — Maia Axon

## Phase 0: Project Setup

- [ ] **B-001** Initialize Python project with Poetry/uv
- [ ] **B-002** Set up FastAPI application structure
- [ ] **B-003** Set up Docker Compose: PostgreSQL, Redis, MinIO
- [ ] **B-004** Configure pgvector extension in PostgreSQL
- [ ] **B-005** Set up Celery with Redis as broker
- [ ] **B-006** Configure structured logging (JSON format)
- [ ] **B-007** Set up Alembic for database migrations
- [ ] **B-008** Create base database models (SQLAlchemy)
- [ ] **B-009** Set up environment config management (.env, pydantic-settings)
- [ ] **B-010** Set up basic CI pipeline (linting, type checking, tests)

---

## Phase 1: User & Group Management

### Users
- [ ] **B-101** Create users table migration
- [ ] **B-102** Build user CRUD API endpoints (create, list, get, update)
- [ ] **B-103** Implement basic internal auth (API keys or simple JWT — no full OAuth yet)
- [ ] **B-104** Add admin role middleware/decorator

### Groups
- [ ] **B-105** Create groups table migration
- [ ] **B-106** Build group CRUD API endpoints (create, list, get, update, delete)
- [ ] **B-107** Create group_assignments table migration
- [ ] **B-108** Build group assignment endpoints (assign user, remove user, list users in group)
- [ ] **B-109** Implement group access control: users only see assigned groups
- [ ] **B-110** `GET /groups` — serves the `#` command: list groups for current user

---

## Phase 2: Document Management & Ingestion Pipeline

### File Upload & Storage
- [ ] **B-201** Create documents table migration
- [ ] **B-202** Build file upload endpoint (`POST /groups/{id}/documents`)
- [ ] **B-203** Validate file type, size, corruption on upload
- [ ] **B-204** Store original PDF in MinIO/S3
- [ ] **B-205** Return document with status tracking
- [ ] **B-206** `GET /groups/{id}/documents` — serves the `@` command: list docs in group
- [ ] **B-207** Build document delete endpoint (admin only)
- [ ] **B-208** Build document replace endpoint (admin only)

### Ingestion Pipeline (Celery Tasks)

GLM-OCR replaces the traditional multi-tool chain (separate OCR, layout, formula, table tools).
It handles layout detection (25 region types), text OCR, formula recognition (→ LaTeX),
and table extraction in one pass, with bounding boxes and structured JSON + Markdown output.

- [ ] **B-209** Create pages table migration
- [ ] **B-210** Task: Split PDF into page images (PyMuPDF)
- [ ] **B-211** Store page images in MinIO/S3
- [ ] **B-212** Install and configure GLM-OCR (`pip install glmocr`)
- [ ] **B-213** Configure GLM-OCR deployment: Zhipu MaaS API for MVP, self-hosted (vLLM/Ollama) for production
- [ ] **B-214** Task: Run GLM-OCR on each page image — produces layout regions + bounding boxes + recognized content (Markdown + JSON)
- [ ] **B-215** Configure GLM-OCR settings: `output_format: both`, `enable_merge_formula_numbers: true`, `layout_nms: true`
- [ ] **B-216** Parse GLM-OCR JSON output into page regions: map `display_formula`/`inline_formula` → equation, `table` → table, `text`/`paragraph_title` → text, `image`/`chart` → figure
- [ ] **B-217** Task: Figure captioning — send `image`/`chart` regions (that GLM-OCR skips) to Claude Vision for text descriptions
- [ ] **B-218** Task: Variable extraction — post-process equation LaTeX with LLM to map variables to definitions using surrounding text context
- [ ] **B-219** Store structured page data (regions JSONB with bounding boxes) in pages table
- [ ] **B-220** Update document status at each pipeline stage (`uploading → splitting → glm_ocr → captioning → embedding → ready`)
- [ ] **B-221** Handle pipeline failures: set status to 'failed' with error_detail
- [ ] **B-222** Build status polling endpoint (`GET /documents/{id}/status`)

### Chunking & Embedding
- [ ] **B-223** Create chunks table migration
- [ ] **B-224** Create chunk_embeddings table migration with pgvector index
- [ ] **B-225** Implement structural chunking logic based on GLM-OCR regions (section, page, equation, table, figure)
- [ ] **B-226** Generate embeddings for each chunk (OpenAI text-embedding-3-large or Cohere)
- [ ] **B-227** Store chunks + embeddings in PostgreSQL
- [ ] **B-228** Build re-indexing endpoint (admin triggers GLM-OCR re-process of a document)

---

## Phase 3: Retrieval Service

### Library Search
- [ ] **B-301** Implement vector similarity search (pgvector cosine distance)
- [ ] **B-302** Implement keyword/BM25 search (PostgreSQL tsvector or pg_trgm)
- [ ] **B-303** Implement hybrid retrieval with reciprocal rank fusion
- [ ] **B-304** Add reranking step (Cohere Rerank API or cross-encoder model)
- [ ] **B-305** Implement group scope filter: only search chunks from active group
- [ ] **B-306** Implement document filter: if `@` used, only search selected document(s)
- [ ] **B-307** Return top-K results with: content, page number, bbox, document name, confidence
- [ ] **B-308** Include page images for top results (for vision LLM context)

### Deep Search (Library + Web)
- [ ] **B-309** Integrate web search API (Tavily or Brave Search)
- [ ] **B-310** Implement web page scraping and content extraction
- [ ] **B-311** Merge and deduplicate library + web results
- [ ] **B-312** Unified reranking across both source types
- [ ] **B-313** Tag each result with source_type: "pdf" or "web"

---

## Phase 4: Answer Engine

### Orchestration
- [ ] **B-401** Set up LangGraph workflow for answer orchestration
- [ ] **B-402** Implement intent classifier: Q&A vs Calculation vs Ambiguous
- [ ] **B-403** Build conversation memory: load recent messages for context
- [ ] **B-404** Implement active group tracking per user session (Redis)

### Q&A Agent
- [ ] **B-405** Build Q&A agent: answer from retrieved sources with inline citations
- [ ] **B-406** Implement citation mapping: link answer segments to source chunks with bbox
- [ ] **B-407** Separate cited content from model-derived reasoning in output
- [ ] **B-408** Add OCR confidence warnings when source quality is low

### Calculation Agent
- [ ] **B-409** Build formula extraction from retrieved equation chunks
- [ ] **B-410** Implement multi-method detection: when multiple PDFs give different formulas
- [ ] **B-411** Build variable matcher: map user-provided values to formula variables
- [ ] **B-412** Detect missing variables and generate clarifying questions
- [ ] **B-413** Implement automatic unit conversion (pint library)
- [ ] **B-414** Set up sandboxed Python execution (Docker or RestrictedPython)
- [ ] **B-415** Execute calculations in sandbox with numpy/scipy/sympy
- [ ] **B-416** Format step-by-step output: formula → variables → substitution → result
- [ ] **B-417** Tag each step as "from PDF" (cited) or "model-derived" (uncited)
- [ ] **B-418** Expose all variables used for auditability

### Clarification Agent
- [ ] **B-419** Build clarification detection logic
- [ ] **B-420** Generate structured clarifying questions when input is ambiguous or incomplete

### Response Builder
- [ ] **B-421** Build response formatter: answer + calculation steps + citations + warnings
- [ ] **B-422** Generate citation objects with document_id, page, bbox, snippet
- [ ] **B-423** Build mindmap data structure from answer provenance

---

## Phase 5: Mindmap Service

- [ ] **B-501** Implement provenance tracer: track which sources contributed to each answer part
- [ ] **B-502** Build graph data structure: nodes (answer, sources, sub-conclusions) + edges
- [ ] **B-503** Generate mindmap JSON for frontend rendering
- [ ] **B-504** Include clickable references: PDF citations and web URLs in node data

---

## Phase 6: Conversations & Chat

- [ ] **B-601** Create conversations and messages table migrations
- [ ] **B-602** Build conversation CRUD endpoints (create, list, get, delete)
- [ ] **B-603** Build message endpoints (send message, list messages in conversation)
- [ ] **B-604** Scope conversations to groups: conversation belongs to a group
- [ ] **B-605** Implement WebSocket endpoint for streaming responses
- [ ] **B-606** Stream tokens, then citations, then mindmap, then done signal
- [ ] **B-607** Store assistant responses (content, citations, mindmap) in messages table
- [ ] **B-608** Implement conversation title generation (auto-title from first message)

---

## Phase 7: API Endpoints Summary

```
Auth & Users
  POST   /auth/login
  GET    /users/me
  GET    /users                    (admin)
  POST   /users                   (admin)

Groups
  GET    /groups                   (# command — user's assigned groups)
  POST   /groups                  (admin)
  PUT    /groups/{id}             (admin)
  DELETE /groups/{id}             (admin)
  POST   /groups/{id}/assign      (admin — assign user)
  DELETE /groups/{id}/assign/{uid} (admin — remove user)

Documents
  GET    /groups/{id}/documents    (@ command — docs in group)
  POST   /groups/{id}/documents    (admin — upload)
  DELETE /documents/{id}           (admin)
  GET    /documents/{id}/status    (indexing status)
  POST   /documents/{id}/reindex   (admin — re-process)
  GET    /documents/{id}/pages/{n} (page image + regions)

Conversations
  GET    /conversations            (user's conversations)
  POST   /conversations            (create, with group_id)
  GET    /conversations/{id}       (get with messages)
  DELETE /conversations/{id}

Chat
  WS     /ws/chat                  (streaming chat)
  POST   /chat                     (non-streaming fallback)

Search (internal, used by answer engine — not user-facing)
  POST   /search/library
  POST   /search/deep
```

---

## Phase 8: Testing & Quality

- [ ] **B-801** Unit tests for ingestion pipeline (each stage)
- [ ] **B-802** Unit tests for chunking logic
- [ ] **B-803** Unit tests for retrieval (vector + keyword + hybrid)
- [ ] **B-804** Integration tests for full question-answer flow
- [ ] **B-805** Integration tests for calculation agent with sandbox
- [ ] **B-806** Load test for concurrent queries
- [ ] **B-807** Test GLM-OCR output quality on sample scanned PDFs (text, formulas, tables)
- [ ] **B-808** Test GLM-OCR bounding box accuracy (do highlights land on correct regions?)
- [ ] **B-809** Test GLM-OCR LaTeX output accuracy on sample equations
- [ ] **B-810** Benchmark GLM-OCR: cloud API vs self-hosted latency and throughput
