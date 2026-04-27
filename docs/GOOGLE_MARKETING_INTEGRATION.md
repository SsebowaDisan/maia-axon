# Google Marketing Integration for Maia

## Goal

Let Maia answer questions over a company's live Google Analytics 4 and Google Ads data, for example:

- "What were the top landing pages last 30 days?"
- "Which campaigns spent the most this week?"
- "Compare conversions and CPA for Brand vs Non-Brand."

The integration should be project-scoped in Maia so each company/workspace can connect its own Google assets.

## Important Identifier Model

Do not model this as only "property ID per company or campaign".

Use the real Google scopes:

- `Google Analytics 4`: `property_id` is the top-level reporting target.
- `Google Ads`: `customer_id` is the top-level reporting target.
- `Google Ads manager access`: `login_customer_id` is often needed when accessing a client account through a manager account.
- `Campaign`: campaign is a reporting filter under a property or customer, not the primary auth target.

So the correct Maia model is:

- one `project` can have one or more GA4 properties
- one `project` can have one or more Google Ads customer accounts
- optional saved campaign scopes can sit under those connections

## Recommended Access Model

For your setup, service-account access is the cleanest first version.

- Create one Google Cloud service account for Maia.
- Store the service account JSON key file on the Maia backend only.
- Do not ask end users to upload the JSON key.
- Grant that service account read access to each GA4 property Maia should query.
- Grant that service account access to the Google Ads account directly, or to the Google Ads manager account that manages the client accounts.

This fits your "service emails" idea well.

Implementation note:

- `service account email` = the robot identity users/admin share files or analytics access with
- `JSON key file` = backend-only credential Maia uses to prove it is that service account
- `property ID`, `sheet URL`, `spreadsheet ID`, and `Ads customer ID` = the target Maia should read from or write to

So the user should never upload the key file. The backend owns it.

## Maia Data Model

Add a connector table instead of storing IDs on conversations.

### `google_connections`

- `id`
- `project_id`
- `provider` (`ga4` or `google_ads`)
- `name`
- `status`
- `service_account_email`
- `secret_ref`
- `ga_property_id` nullable
- `ads_customer_id` nullable
- `ads_login_customer_id` nullable
- `default_date_range`
- `timezone`
- `currency_code`
- `created_at`
- `updated_at`

Rules:

- `ga4` rows require `ga_property_id`
- `google_ads` rows require `ads_customer_id`
- `ads_login_customer_id` is optional but common for manager-account access

### `google_connection_campaign_scopes`

Optional saved filters:

- `id`
- `connection_id`
- `scope_name`
- `campaign_id`
- `campaign_name`
- `is_default`

This lets a company save scopes like:

- "Brand Search"
- "DACH Performance Max"
- "Spring Launch"

## Product Behavior

### Project-scoped configuration

In Maia, attach Google assets to a `project`, because `project` is already the clean company/workspace boundary in this repo.

That gives you:

- Company A project -> GA4 property 123456789 + Ads customer 1112223333
- Company B project -> GA4 property 987654321 + Ads customer 4445556666

### Writing reports to Google Docs or Sheets

If users want Maia to write reports, research, or summaries into Google Docs or Google Sheets:

- they must provide the Google Docs or Google Sheets link
- they must share that file with Maia's service-account email first
- Maia should verify access before attempting to write

Use the real file identifiers derived from the URLs:

- Google Docs URL -> `documentId`
- Google Sheets URL -> `spreadsheetId`

Do not let Maia write to arbitrary Drive files by title search alone. Require an explicit link or a previously saved approved destination.

Recommended permission level:

- `Docs`: writer/editor access on the target document
- `Sheets`: writer/editor access on the target spreadsheet

If the file is in a shared drive, the service account must have a role that actually permits writing and sharing according to that drive's rules.

### Chat behavior

When a user is in a project and asks a Google-data question:

1. Maia detects that the question targets GA4 or Google Ads.
2. Maia picks the matching connector(s) for the active project.
3. Maia converts the prompt into a safe structured query:
   - GA4 Data API request for metrics, dimensions, date ranges, filters
   - Google Ads GAQL query for campaign, ad group, search term, spend, clicks, conversions, and related metrics
4. Maia executes the query live or against a recent cache.
5. Maia answers in normal Maia format with:
   - result summary
   - date range used
   - account/property used
   - tabular evidence
   - warnings when the question is ambiguous

## Routing Design

Add a dedicated Google data tool path beside document retrieval.

Current flow in this repo is:

- chat endpoint
- answer engine
- retrieval

Add:

- `app/services/google_marketing/ga4.py`
- `app/services/google_marketing/google_ads.py`
- `app/services/google_marketing/router.py`

Suggested flow:

1. Classify whether the question is document-grounded, direct LLM, or Google-data.
2. If Google-data:
   - resolve active `project_id`
   - load connectors for that project
   - pick provider
   - build a structured query plan
   - execute provider client
   - convert response into Maia citations/evidence blocks

## Query Strategy

Do not let the LLM generate raw API calls without guardrails.

Use a limited internal query schema.

### For GA4

Allow Maia to generate:

- date ranges
- dimensions from an allowlist
- metrics from an allowlist
- simple filters
- order by
- limit

Example intents:

- traffic overview
- top landing pages
- source / medium performance
- campaign performance
- geo breakdown
- device breakdown
- conversion trend

### For Google Ads

Allow Maia to generate:

- resource target (`campaign`, `ad_group`, `search_term_view`, `customer`)
- metrics from an allowlist
- segment fields from an allowlist
- date range
- campaign filters
- limit and sorting

Example intents:

- spend, clicks, impressions, CTR
- CPC, CPA, ROAS
- conversion counts and conversion value
- campaign comparison
- branded vs non-branded performance

## Live Query vs Cache

Start hybrid:

- default to live query for focused user questions
- cache normalized results for short periods such as 5 to 30 minutes
- optionally run nightly summary jobs for trend-heavy questions

Why:

- live queries keep answers current
- cache protects quotas and lowers latency
- nightly summaries help with broader analytical prompts

## Answer Quality Requirements

Every Google-data answer should include:

- the source provider (`GA4` or `Google Ads`)
- the property or customer used
- the date range used
- any campaign filter used
- a short caveat when the metric may be misleading

Examples:

- GA4 campaign reporting depends on the property's tracking quality and attribution setup.
- Ads conversions can differ from GA4 conversions because the attribution models differ.

## Security

- Store service-account secrets outside the database when possible.
- Keep only a secret reference in Postgres.
- Restrict scopes to read-only.
- Audit which project can access which property/customer.
- Never let a user type arbitrary IDs and query accounts not mapped to their project.

For Docs/Sheets export:

- keep report-writing separate from analytics-reading scopes where practical
- store approved destination file IDs per project if the user wants reusable outputs
- reject writes when the provided link is not reachable by the service account
- surface the service-account email clearly in the UI so the user knows what to share the file with

## Implementation Order

### Phase 1

- Add connector tables and models
- Add admin endpoints to create/edit/test GA4 and Ads connections
- Add Docs/Sheets export destination records based on user-provided links
- Add provider clients with one or two fixed reports each
- Add chat routing for "analytics" and "ads" questions

### Phase 2

- Add structured query planner
- Add campaign scopes
- Add result caching
- Add Docs and Sheets write helpers
- Add answer citations for tables and trends

### Phase 3

- Add richer saved reports
- Add blended answers combining GA4 and Ads
- Add anomaly detection and weekly summaries

## Agreed V1 Product Spec

### Core model

- `Projects` stay as they are.
- `Companies` are admin-managed source profiles.
- `Google Analytics` and `Google Ads` behave like chat source modes, similar to `Library` and `Deep Search`.
- `Google Docs` and `Google Sheets` are user-managed export destinations.

### Admin flow

1. Admin opens `Admin -> Companies`.
2. Admin creates a company.
3. Admin adds the company's source configuration:
   - `GA4 property ID`
   - `Google Ads customer ID`
   - optional later: `Google Ads login customer ID`
4. Admin controls which users can access which companies.
5. Only admin-created companies appear in chat pickers.

### User flow

1. User opens a project chat.
2. User clicks `+`.
3. User chooses one of:
   - `Standard`
   - `Library`
   - `Deep Search`
   - `Google Analytics`
   - `Google Ads`
4. If the user picks `Google Analytics`, Maia opens a company picker.
5. If the user picks `Google Ads`, Maia opens a company picker.
6. User selects the company.
7. The selection appears as a composer chip, for example:
   - `GA4 · Acme`
   - `Ads · Acme`
8. User asks the question.
9. Maia queries the configured source for that company.

### Docs and Sheets export flow

1. Maia answers in chat.
2. User clicks `Write to Docs` or `Write to Sheets` on the response.
3. If no destination exists yet, Maia opens a setup modal:
   - paste Docs or Sheets link
   - show Maia service email
   - user shares the file with that service email
   - `Test access`
   - `Save destination`
   - `Write now`
4. Maia stores that destination for the user.
5. Next time, the user can write directly to a saved destination.

Default export behavior:

- Exports should include the charts by default when the answer contains quantitative visualizations.
- Google Docs exports should include rendered chart images together with the narrative summary and the underlying table where useful.
- Google Sheets exports should include:
  - the structured data table
  - an inserted chart built from that table when practical
  - the summary text in a clear report section or separate sheet
- Users may later get an option to export "text only", but v1 default is `include graphs`.
- Once the user has shared the target file with Maia's service email, Maia should write directly into that destination as a rich report artifact.

### Interactive report graphs in the UI

For Google Analytics and Google Ads answers, Maia should also render interactive graphs directly in the chat UI when the result is quantitative.

Examples:

- traffic trend over time
- spend, clicks, CTR, CPC, CPA, conversions
- top campaigns comparison
- source / medium breakdown
- landing page performance

Expected behavior:

- Maia returns both narrative text and chart-ready structured data.
- The UI renders the graph inline inside the assistant response.
- The graph reacts to hover, legend toggles, and resizing.
- The graph remains tied to the active answer and does not become a disconnected dashboard.

Recommended chart types:

- `line` for time series
- `bar` for ranked comparisons
- `stacked_bar` for segmented comparisons
- `area` for trend volume
- `pie` only for small categorical breakdowns

Graph interactions:

- hover tooltip
- responsive resize
- series toggle on/off
- empty-state and error-state handling
- optional switch between chart and table view

Export expectation:

- The same chart intent shown in the UI should carry into Docs and Sheets exports by default.
- The exported report should feel like a real report artifact, not a plain transcript dump.
- Rich export quality is required when Maia writes directly to user-provided Docs or Sheets destinations.

### LLM-selected dashboard structure

Do not hardcode one fixed dashboard layout for every Google Analytics or Google Ads answer.

The backend should use safe, allowlisted query planners to fetch data, but after the data is returned Maia should ask the LLM to choose the best dashboard structure for the user's exact question.

Rules:

- The LLM may choose dashboard composition, chart titles, chart types, metric emphasis, and which supporting views to show.
- The LLM must not create raw GA4 API requests or raw Google Ads GAQL directly without backend guardrails.
- The LLM must only choose from metrics, dimensions, and rows already returned by the backend.
- The backend must validate every LLM dashboard decision before returning it to the frontend.
- If the LLM returns an invalid dashboard plan, Maia should fall back to a deterministic safe dashboard.

Allowed dashboard decisions:

- primary visual type:
  - `line` or `area` for time trends
  - `bar` for rankings and comparisons
  - `stacked_bar` only for meaningful composition
  - `pie` only for small part-to-whole breakdowns
- primary and supporting metrics
- row limits for top-N views
- business-readable titles and subtitles
- whether the answer needs one large hero chart or several supporting charts

For Google Ads specifically, the prompt should encourage the LLM to consider:

- spend / cost
- clicks
- impressions
- conversions
- CTR
- average CPC
- CPA when available
- conversion value and ROAS when available
- campaign, device, date, ad group, and search-term context when returned

This makes Maia's dashboard feel generated by the analytical question, not by a static BI template.

### UX rules

- Company picker belongs in the composer flow.
- Company setup belongs in admin, not in the composer.
- Docs and Sheets are output actions, not source modes.
- If only one company is available for a mode, auto-select it.
- If multiple companies are available, show a searchable picker.
- Remember the last selected company per mode.
- Never show companies the user is not allowed to access.
- For quantitative answers, prefer showing a graph plus a compact summary rather than text alone.
- Charts belong inside the assistant response body, near the explanation and before export actions.
- If a response shows charts in Maia, Docs and Sheets export should include those charts by default.
- Direct-write exports to Docs and Sheets should produce polished report layouts with headings, summaries, charts, and tables where useful.

### Data model

#### `companies`

- `id`
- `name`
- `ga4_property_id`
- `google_ads_customer_id`
- `google_ads_login_customer_id` nullable
- `created_at`
- `updated_at`

#### `company_users`

- `company_id`
- `user_id`

#### `user_export_destinations`

- `id`
- `user_id`
- `type` (`google_doc`, `google_sheet`)
- `title`
- `url`
- `file_id`
- `status`
- `last_verified_at`

#### `message_visualizations` or inline message payload

For v1, the simplest option is to include visualization data directly on assistant messages.

- `type` (`line`, `bar`, `stacked_bar`, `area`, `pie`, `table`)
- `title`
- `subtitle`
- `x_key`
- `series`
- `rows`
- `meta` (`date_range`, `company_name`, `source_mode`, `currency`, `notes`)

#### export behavior

The export layer should consume the same visualization payload used by the UI so charts do not need to be re-invented separately for Docs and Sheets.

- `Google Docs`: render chart image assets from the visualization payload and place them in the report
- `Google Sheets`: write tabular rows first, then create chart objects from those rows where supported

Rich report expectations:

- `Google Docs` reports should include:
  - clear title
  - company name
  - source label (`Google Analytics` or `Google Ads`)
  - date range
  - executive summary
  - section headings
  - charts by default
  - supporting tables where needed
  - short notes or caveats when metric interpretation matters
- `Google Sheets` reports should include:
  - a clean summary area
  - underlying data tables
  - generated charts by default
  - sensible sheet naming
  - readable headers and formatting

The export should be designed as a stakeholder-ready report, not a raw assistant transcript.

### Frontend changes

- Add `Google Analytics` and `Google Ads` to the `+` menu.
- Add a `CompanySelector` popover for both modes.
- Add source chips in the composer.
- Add inline chart components for assistant responses.
- Add `Write to Docs` and `Write to Sheets` actions on assistant messages.
- Add `Admin -> Companies` management UI.

### Backend changes

- Add company models and admin CRUD endpoints.
- Add company-to-user access mapping.
- Add GA4 and Ads routing/services.
- Add structured visualization payloads to answer responses for quantitative results.
- Add Docs/Sheets destination save/test/write endpoints.
- Add export helpers that turn visualization payloads into Docs-ready chart images and Sheets-ready chart/table outputs.
- Add report formatting helpers so direct-write Docs and Sheets exports are rich, structured, and presentation-ready.

### Recommended build order

1. Admin company CRUD
2. Company access control
3. Composer modes and company picker
4. GA4 query path
5. Google Ads query path
6. Inline chart payloads and chart rendering
7. Docs/Sheets destination save and export actions with charts included by default

## Roadmap

### Phase 0 - Foundation and schema

Goal:

- Create the backend structures needed for companies, company access, and export destinations without changing the current project-based chat flow.

Deliverables:

- `companies` table
- `company_users` table
- `user_export_destinations` table
- backend models, schemas, and migrations
- admin-only CRUD endpoints for companies

Done when:

- admin can create, edit, list, and delete companies
- users do not yet see Google modes in chat
- existing chat, projects, and library flows remain unaffected

### Phase 1 - Admin company management

Goal:

- Give admin a clear UI to manage the companies that will later appear in Google mode pickers.

Deliverables:

- `Admin -> Companies` UI
- create/edit company form
- fields for:
  - company name
  - GA4 property ID
  - Google Ads customer ID
  - optional Google Ads login customer ID
- user assignment to companies

Done when:

- admin can create companies and attach source IDs
- admin can control which users can access which companies
- the system can return only allowed companies for a user

### Phase 2 - Composer source modes and company picker

Goal:

- Make Google Analytics and Google Ads feel like first-class chat source modes, similar to Library and Deep Search.

Deliverables:

- add `Google Analytics` and `Google Ads` to the composer `+` menu
- add company picker popovers
- add selected company chips in the composer
- remember last selected company per mode

Done when:

- user can select `Google Analytics` or `Google Ads`
- user can choose one permitted company
- selected company is visible before the message is sent

### Phase 3 - Google Analytics query path

Goal:

- Let Maia answer GA4 questions from the selected company inside project chat.

Deliverables:

- `google_analytics` chat mode in REST and WebSocket flows
- GA4 service client
- query planner for common GA4 question types
- structured answer payloads with:
  - summary text
  - source metadata
  - table data
  - visualization payload

Example supported questions:

- traffic trends
- top landing pages
- source / medium performance
- campaign performance
- geography and device breakdowns

Done when:

- user can select a company in `Google Analytics` mode
- Maia returns correct narrative results plus table/chart-ready output
- the answer stays inside the normal project chat flow

### Phase 4 - Google Ads query path

Goal:

- Let Maia answer Google Ads questions from the selected company inside project chat.

Deliverables:

- `google_ads` chat mode in REST and WebSocket flows
- Google Ads service client
- GAQL query planner for common Ads question types
- structured answer payloads with:
  - summary text
  - source metadata
  - table data
  - visualization payload

Example supported questions:

- spend and clicks over time
- campaign comparison
- CTR, CPC, CPA, ROAS
- conversion performance

Done when:

- user can select a company in `Google Ads` mode
- Maia returns readable Ads analysis with structured output for charts and tables

### Phase 5 - Interactive charts in Maia UI

Goal:

- Make quantitative results feel like real analysis, not text-only answers.

Deliverables:

- inline chart components in assistant messages
- support for:
  - line charts
  - bar charts
  - stacked bar charts
  - area charts
  - small pie charts where appropriate
- responsive chart layout in the chat UI
- fallback table view

Done when:

- Google Analytics and Google Ads answers render interactive charts inside the message UI
- charts resize correctly and remain readable on desktop and mobile
- charts and tables reflect the same underlying data as the narrative answer

### Phase 6 - Docs and Sheets destination management

Goal:

- Let users save destinations where Maia can write reports directly.

Deliverables:

- `Write to Docs` and `Write to Sheets` actions on assistant answers
- destination setup modal
- link parsing for:
  - Google Docs `documentId`
  - Google Sheets `spreadsheetId`
- access test flow
- saved export destinations per user

Done when:

- user can paste a Docs or Sheets link
- user sees Maia's service email
- Maia verifies access after the file is shared
- saved destinations can be reused later

### Phase 7 - Rich direct-write report exports

Goal:

- Produce stakeholder-ready reports directly inside user-provided Docs and Sheets files.

Deliverables:

- Docs export formatter
- Sheets export formatter
- chart export pipeline
- table export pipeline
- report templates for:
  - summary section
  - date range and source label
  - charts by default
  - supporting tables
  - notes / caveats

Done when:

- exported Docs include formatted headings, summary text, and chart images by default
- exported Sheets include data tables, charts, and readable sheet layout by default
- exports feel like polished reports, not transcript dumps

### Phase 8 - Hardening and quality

Goal:

- Make the feature safe, reliable, and ready for wider use.

Deliverables:

- error handling for missing company config
- permission checks for company access
- retry and failure states for Docs/Sheets export
- logging and auditability
- tests for:
  - company CRUD
  - access control
  - company picker flow
  - GA4 mode
  - Google Ads mode
  - report export generation

Done when:

- the main user journeys are covered by automated tests
- failure states are understandable in the UI
- admins can operate the system without manual database intervention

### Recommended implementation sequence

1. Phase 0 - Foundation and schema
2. Phase 1 - Admin company management
3. Phase 2 - Composer source modes and company picker
4. Phase 3 - Google Analytics query path
5. Phase 4 - Google Ads query path
6. Phase 5 - Interactive charts in Maia UI
7. Phase 6 - Docs and Sheets destination management
8. Phase 7 - Rich direct-write report exports
9. Phase 8 - Hardening and quality

## Backend Roadmap

### Backend Stage 1 - Data model and migrations

Goal:

- Introduce the minimum persistent structures for companies, company access, and export destinations.

Tasks:

- create `Company` model
- create `CompanyUser` model
- create `UserExportDestination` model
- add Alembic migrations for all three
- register new models in SQLAlchemy imports where needed

Suggested files:

- `backend/app/models/company.py`
- `backend/app/models/__init__.py`
- `backend/alembic/versions/<new_revision>.py`

Done when:

- the database can store companies, company-user mappings, and user Docs/Sheets destinations
- migration applies cleanly on a fresh database and existing database

### Backend Stage 2 - Admin company APIs

Goal:

- Allow admin to manage company records and access mappings entirely through API endpoints.

Tasks:

- add company schemas
- add admin CRUD endpoints for companies
- add endpoints to assign and remove users from companies
- ensure admin-only protection

Suggested files:

- `backend/app/schemas/company.py`
- `backend/app/api/endpoints/companies.py`
- `backend/app/api/router.py`

Done when:

- admin can create, edit, list, and delete companies
- admin can assign users to companies
- non-admin users cannot mutate company configuration

### Backend Stage 3 - Chat protocol extension

Goal:

- Extend existing chat payloads to support Google source modes without breaking current project or group flows.

Tasks:

- add `google_analytics` and `google_ads` to accepted chat modes
- add `company_id` to REST and WebSocket chat payloads
- keep `group_id` required only for `library` and `deep_search`
- validate `company_id` for Google modes

Suggested files:

- `backend/app/schemas/conversation.py`
- `backend/app/api/endpoints/chat.py`
- `backend/app/api/endpoints/ws.py`

Done when:

- chat endpoints accept Google modes
- current `standard`, `library`, and `deep_search` flows still behave exactly as before

### Backend Stage 4 - Company access resolution

Goal:

- Ensure users can query only the companies they are allowed to access.

Tasks:

- implement company access checks
- load only permitted companies for the authenticated user
- reject Google-mode requests for unauthorized companies

Suggested files:

- `backend/app/api/endpoints/companies.py`
- `backend/app/api/endpoints/chat.py`
- `backend/app/api/endpoints/ws.py`
- optional helper module such as `backend/app/api/deps.py` or a new access helper

Done when:

- unauthorized company IDs are rejected cleanly
- user company lists are filtered correctly

### Backend Stage 5 - Google Analytics service path

Goal:

- Execute GA4 queries using the selected company's property ID and return structured report data.

Tasks:

- implement GA4 client wrapper
- map common question intents to safe GA4 query shapes
- support date ranges, metrics, dimensions, filters, sorting, and limits
- normalize results into a Maia-friendly response object

Suggested files:

- `backend/app/services/google_marketing/ga4.py`
- `backend/app/services/google_marketing/router.py`

Done when:

- a user can ask GA4 questions against a selected company
- backend returns summary text plus structured table/chart data

### Backend Stage 6 - Google Ads service path

Goal:

- Execute Google Ads queries using the selected company's Ads account configuration and return structured report data.

Tasks:

- implement Google Ads client wrapper
- build safe GAQL query generation for supported question types
- support customer ID and optional login customer ID
- normalize results into a Maia-friendly response object

Suggested files:

- `backend/app/services/google_marketing/google_ads.py`
- `backend/app/services/google_marketing/router.py`

Done when:

- a user can ask Ads questions against a selected company
- backend returns structured results compatible with Maia charts and report exports

### Backend Stage 7 - Structured visualization payloads

Goal:

- Return chart-ready data from the backend so the frontend does not infer graphs from prose, while letting the LLM choose dashboard structure from safe returned data.

Tasks:

- extend answer response payloads with visualization blocks
- define supported visualization types
- attach metadata such as company, date range, source mode, and currency
- add an LLM dashboard-design prompt that receives the user question, safe returned rows, available metrics, and source metadata
- validate LLM-selected chart types, metric keys, row limits, and titles before sending visualizations to the frontend
- keep deterministic fallback visualizations for no-key, invalid-plan, or model-failure cases

Suggested files:

- `backend/app/services/answer_engine.py`
- `backend/app/api/endpoints/chat.py`
- `backend/app/api/endpoints/ws.py`
- related response schemas

Done when:

- assistant messages can include visualization payloads consistently for quantitative answers
- Google Analytics and Google Ads dashboards are question-aware instead of fixed-template only

### Backend Stage 8 - Export destination APIs

Goal:

- Let users save and validate Docs/Sheets destinations Maia can write into.

Tasks:

- add endpoints to create, list, update, and delete export destinations
- parse Docs and Sheets URLs into file IDs
- test destination access after user shares the file with Maia's service email

Suggested files:

- `backend/app/schemas/export_destination.py`
- `backend/app/api/endpoints/export_destinations.py`
- `backend/app/api/router.py`

Done when:

- user can save a Docs or Sheets destination
- backend can verify whether Maia has access to write there

### Backend Stage 9 - Rich report export pipeline

Goal:

- Generate polished Docs and Sheets reports with charts and tables by default.

Tasks:

- create Docs export formatter
- create Sheets export formatter
- render chart payloads into Docs-ready images
- map chart/table payloads into Sheets tabs and chart objects
- include title, summary, date range, source labels, charts, tables, and caveats

Suggested files:

- `backend/app/services/google_exports/docs_writer.py`
- `backend/app/services/google_exports/sheets_writer.py`
- `backend/app/services/google_exports/chart_renderer.py`

Done when:

- Maia can write directly to user-provided Docs or Sheets files
- exported reports are rich, structured, and chart-inclusive by default

### Backend Stage 10 - Testing and hardening

Goal:

- Make the backend safe and reliable for production use.

Tasks:

- add tests for company CRUD
- add tests for company access control
- add tests for Google mode request validation
- add tests for GA4 and Ads response normalization
- add tests for export destination parsing and validation
- add tests for report export formatting

Suggested files:

- `backend/tests/*`

Done when:

- the main backend user journeys are covered by automated tests
- failures return clean and predictable API errors

## Frontend Roadmap

### Frontend Stage 1 - Type system and API client

Goal:

- Extend frontend typing and API access to support companies, Google modes, visualization payloads, and export destinations.

Tasks:

- extend `SearchMode`
- add `Company` types
- add visualization types
- add export destination types
- add API methods for companies and export destinations

Suggested files:

- `frontend/src/lib/types.ts`
- `frontend/src/lib/api.ts`

Done when:

- frontend can fetch company and export-destination data with strong typing

### Frontend Stage 2 - State management

Goal:

- Persist company selections and company lists cleanly in stores.

Tasks:

- add `companyStore`
- store available companies for the user
- store selected company per Google mode
- optionally store recent company selection

Suggested files:

- `frontend/src/stores/companyStore.ts`
- `frontend/src/stores/chatStore.ts`

Done when:

- frontend state can track available companies and active company selection cleanly

### Frontend Stage 3 - Admin company management UI

Goal:

- Give admin a clear UI for managing companies and access.

Tasks:

- add `CompanyManager` admin component
- add create/edit form for company config
- add company-user assignment controls
- place the screen under existing admin workspace patterns

Suggested files:

- `frontend/src/components/admin/CompanyManager.tsx`
- `frontend/src/components/layout/SidebarHistory.tsx`

Done when:

- admin can manage companies fully from the UI

### Frontend Stage 4 - Composer Google modes

Goal:

- Make Google Analytics and Google Ads available as source modes from the composer `+` menu.

Tasks:

- add `Google Analytics` menu item
- add `Google Ads` menu item
- keep `Standard`, `Library`, and `Deep Search` intact
- update mode badges and labels everywhere they appear

Suggested files:

- `frontend/src/components/chat/ComposerMenu.tsx`
- `frontend/src/components/chat/Composer.tsx`
- `frontend/src/components/chat/MessageBubble.tsx`

Done when:

- user can switch into Google modes from the existing composer UX

### Frontend Stage 5 - Company picker UX

Goal:

- Let users choose the company before sending Google-mode questions.

Tasks:

- build `CompanySelector` popover
- support search/filter
- show company name and available source labels
- show selected company as a removable chip in the composer
- auto-select if only one company is available

Suggested files:

- `frontend/src/components/chat/CompanySelector.tsx`
- `frontend/src/components/chat/Composer.tsx`

Done when:

- selecting a company is explicit, visible, and fast

### Frontend Stage 6 - Chat message integration

Goal:

- Send the right company context with Google-mode prompts and render returned source metadata.

Tasks:

- include `company_id` in chat payloads
- relax current group-only assumptions for Google modes
- show source chip or source badge in the assistant answer

Suggested files:

- `frontend/src/stores/chatStore.ts`
- `frontend/src/lib/types.ts`
- `frontend/src/components/chat/MessageBubble.tsx`

Done when:

- Google-mode messages send the correct company context
- the user can see which source/company was used in the answer

### Frontend Stage 7 - Interactive chart components

Goal:

- Render rich, reactive visualizations directly inside assistant messages.

Tasks:

- add chart container component
- add line, bar, stacked bar, area, and limited pie renderers
- add tooltips, legends, responsive behavior, and empty states
- add optional chart/table toggle

Suggested files:

- `frontend/src/components/chat/MessageVisualization.tsx`
- `frontend/src/components/chat/charts/*`
- `frontend/src/components/chat/MessageBubble.tsx`

Done when:

- Google Analytics and Ads answers can show inline interactive graphs in chat

### Frontend Stage 8 - Docs/Sheets export setup UI

Goal:

- Let users save where Maia should write reports directly.

Tasks:

- add `Write to Docs` action
- add `Write to Sheets` action
- build destination setup modal
- show Maia service email in the modal
- show access-test results and saved destinations

Suggested files:

- `frontend/src/components/chat/ExportDestinationDialog.tsx`
- `frontend/src/components/chat/MessageBubble.tsx`
- optional destination settings component

Done when:

- user can save a Docs or Sheets destination directly from chat

### Frontend Stage 9 - Rich report export UX

Goal:

- Make direct-write exports feel intentional and report-oriented.

Tasks:

- show export progress and success states
- confirm that charts and tables will be included by default
- show destination selection if multiple saved destinations exist
- allow direct export from answers containing graphs

Suggested files:

- `frontend/src/components/chat/MessageBubble.tsx`
- `frontend/src/components/chat/ExportDestinationDialog.tsx`

Done when:

- users can reliably export stakeholder-ready reports from chat

### Frontend Stage 10 - QA and polish

Goal:

- Ensure the feature feels coherent across desktop, tablet, and mobile.

Tasks:

- verify responsive behavior for company picker and charts
- verify loading, empty, and error states
- verify mode switching does not break existing flows
- verify exports are understandable to end users

Done when:

- the feature feels native to Maia rather than bolted on
- existing chat, library, and deep search experiences remain stable

## Implementation Kickoff Tasks

These are the immediate repo tasks to start implementation.

### Sprint 1 goal

- Establish the persistent company model and expose admin APIs/UI for managing companies before touching Google query execution.

### Backend kickoff checklist

1. Create `backend/app/models/company.py`
   Add:
   - `Company`
   - `CompanyUser`
   - `UserExportDestination`

2. Update `backend/app/models/__init__.py`
   Export the new models so Alembic and imports stay consistent.

3. Create a new Alembic migration in `backend/alembic/versions/`
   Add tables:
   - `companies`
   - `company_users`
   - `user_export_destinations`

4. Create `backend/app/schemas/company.py`
   Add:
   - `CompanyCreate`
   - `CompanyUpdate`
   - `CompanyResponse`
   - `CompanyUserAssign`

5. Create `backend/app/schemas/export_destination.py`
   Add:
   - `ExportDestinationCreate`
   - `ExportDestinationResponse`

6. Create `backend/app/api/endpoints/companies.py`
   Add admin endpoints:
   - `GET /companies`
   - `POST /companies`
   - `PUT /companies/{company_id}`
   - `DELETE /companies/{company_id}`
   - `POST /companies/{company_id}/users`
   - `DELETE /companies/{company_id}/users/{user_id}`

7. Update `backend/app/api/router.py`
   Register the new companies router.

8. Add tests under `backend/tests/`
   Initial tests:
   - admin can create company
   - admin can list companies
   - non-admin cannot create company
   - admin can assign user to company

### Frontend kickoff checklist

1. Update `frontend/src/lib/types.ts`
   Add:
   - `Company`
   - `CompanyUserAssignment` if needed for UI

2. Update `frontend/src/lib/api.ts`
   Add company API methods:
   - `listCompanies`
   - `createCompany`
   - `updateCompany`
   - `deleteCompany`
   - `assignCompanyUser`
   - `removeCompanyUser`

3. Create `frontend/src/stores/companyStore.ts`
   Add state for:
   - `companies`
   - `loading`
   - `error`
   - CRUD actions

4. Create `frontend/src/components/admin/CompanyManager.tsx`
   First version should support:
   - company list
   - create company form
   - edit company form
   - delete company
   - placeholder area for future user assignment

5. Update `frontend/src/components/layout/SidebarHistory.tsx`
   Add `CompanyManager` into the admin workspace.

6. Add basic admin UI behavior
   The first version does not need Google mode pickers yet.
   It only needs to let admin manage the company catalog cleanly.

### Definition of done for kickoff

- admin can manage companies through the UI
- company records persist in the database
- API routes are covered by basic tests
- no changes yet to composer modes, Google querying, or export writing

### Immediately after kickoff

Once the kickoff tasks are complete, start the next slice:

1. extend chat modes with `google_analytics` and `google_ads`
2. add company picker UI in the composer
3. pass `company_id` through chat payloads

## Fit With This Repo

This repo already has the right primitives:

- `projects` are the correct tenancy boundary
- conversations already carry `project_id`
- the answer engine already supports multiple answer paths

That means the first implementation should anchor Google integrations to `projects`, not `groups` and not individual chat threads.

## Official References

- Google Analytics Data API property ID:
  https://developers.google.com/analytics/devguides/reporting/data/v1/property-id
- Google Analytics `runReport`:
  https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
- Google Analytics Admin API overview:
  https://developers.google.com/analytics/devguides/config/admin/v1
- Google Ads service accounts:
  https://developers.google.com/google-ads/api/docs/oauth/service-accounts
- Google Ads access model:
  https://developers.google.com/google-ads/api/docs/oauth/access-model
- Google Ads auth headers:
  https://developers.google.com/google-ads/api/rest/auth
- Google Ads query language:
  https://developers.google.com/google-ads/api/docs/query/overview
- Google Drive sharing and permissions:
  https://developers.google.com/workspace/drive/api/guides/manage-sharing
- Google Docs document ID and update methods:
  https://developers.google.com/workspace/docs/api/concepts/document
- Google Sheets write patterns:
  https://developers.google.com/workspace/sheets/api/samples/writing
- Google Sheets scopes:
  https://developers.google.com/workspace/sheets/api/scopes
