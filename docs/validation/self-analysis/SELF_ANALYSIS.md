# Repository Intelligence Report

**brody**  
Generated 2026-09-23T14:03:20.487Z · deterministic (no AI provider)  
Statements are backed by repository evidence in the form `path:line-range`. Findings are labelled **static analyzer** (deterministic) or **AI-inferred**, and **needs verification** where evidence is incomplete.

_This is the condensed report. The **Complete Technical Report** contains every finding, file, symbol and map in full._


## 1. Executive Summary

> **brody: Repository intelligence, code review and code mapping.**

brody is a full-stack monolith (Next.js) built with Next.js, React, organised into 26 functional areas. It exposes 33 API routes and stores 12 data models. It depends on Anthropic, OpenAI, SQLite, GitHub API.

### Snapshot

| Source files | Lines of code | Main languages | Functional areas |
| --- | --- | --- | --- |
| **174** | **48,377** | **TypeScript, CSS, Shell** | **26** |

| API routes | Data models | External services | Critical or high findings |
| --- | --- | --- | --- |
| **33** | **12** | **4** | **0** |

### Key points

- **What it is.** brody: Repository intelligence, code review and code mapping.
- **How it is built.** full-stack monolith (Next.js), using Next.js, React. 174 source files across TypeScript, CSS, Shell.
- **What it does.** 7 capabilities, led by API Layer, User Interface, Content Ingestion.
- **Where the risk is.** No critical or high-severity issues were found; 25 lower-priority findings remain.
- **What to do next.** Add tests for the code, which many files depend on.

### What it does

- API Layer: HTTP/RPC endpoints and request handling.
- User Interface: Pages, components and client-side state.
- Content Ingestion: Collecting and importing data from external sources.
- Infrastructure & Deployment: Build, deployment and operations.
- Application Core: Top-level application code.
- AI Processing: Language-model prompts, agents and inference.
- Deck: Code under src/lib/deck/.

### Health and risk

**No critical or high-severity issues were found; 25 lower-priority findings remain.**

Strengths:

- Automated tests exist (60 test files, Vitest, Playwright).
- A clear structure: full-stack monolith (Next.js).
- Configuration is read from environment variables.

Concerns:

- 11 possible hard-coded credentials found in the code.

### Recommended next steps

| Priority | Action | Why it matters |
| --- | --- | --- |
| **Now** | Add tests for the code, which many files depend on. | — |

### Summary evidence

_The in-depth summary that the executive summary above was distilled from. Each statement links to the code that supports it._

brody: Repository intelligence, code review and code mapping. (Stated in the project's own documentation.) _(`package.json`)_

The repository contains 174 source files (48,377 lines across 264 files) organised into 26 functional areas: API Layer, User Interface, Content Ingestion, Infrastructure & Deployment, Application Core, AI Processing.

Execution begins at src/app/layout.tsx (Next.js root layout (package.json script "dev")), tools/build-worker.mjs (package.json script "build"), scripts/worker.mts (package.json script "worker"). _(`src/app/layout.tsx`, `tools/build-worker.mjs`, `scripts/worker.mts:8`)_

Data enters through 33 API route(s) and 11 page(s) built with Next.js, React. Data is persisted in SQLite through Drizzle ORM, modelled by 12 entities such as projects, credentials, blobs, files. _(`src/app/page.tsx:20`, `src/app/api/ai/models/route.ts:9`)_

It integrates with Anthropic, OpenAI, SQLite, GitHub API. _(`package.json`, `src/lib/config.ts:61`, `package.json`)_

Engineering review found 25 finding(s): 0 critical, 0 high, 8 medium, 17 lower-priority. 25 came from deterministic analyzers and 0 from AI review. 60 test file(s) exist.


## 2. System at a Glance

| Area | Description |
| --- | --- |
| Primary Purpose | Repository intelligence, code review and code mapping |
| Application Type | full-stack monolith (Next.js) (high confidence) |
| Primary Languages | TypeScript (223 files), CSS (1 files), Shell (2 files), SQL (2 files), JavaScript (3 files) |
| Frontend | Next.js, React, Tailwind CSS |
| Backend | custom HTTP handlers |
| Data Layer | Database: SQLite; Access: Drizzle ORM; 12 modelled entities |
| Authentication | no authentication mechanism detected |
| External Services | Anthropic, OpenAI, SQLite, GitHub API |
| Infrastructure | GitHub Actions, Docker, Docker Compose |
| Testing | 60 test files; Vitest, Playwright |

## 3. Architecture Overview

The codebase is best described as a full-stack monolith (Next.js) (high confidence). Both frontend and backend frameworks are present in one codebase.

Files divide into these layers: Entry Points (6), Presentation / UI (18), API / Transport (40), Domain / Services (96), Background Processing (2), AI (11), Data (4), Infrastructure & Config (11), Tests & Docs (66).

The largest functional areas are Testing (60 files), API Layer (27 files), Documentation (17 files), User Interface (15 files), Content Ingestion (13 files).

**Layers:** Entry Points (6 files) · Presentation / UI (18 files) · API / Transport (40 files) · Domain / Services (96 files) · Background Processing (2 files) · AI (11 files) · Data (4 files) · Infrastructure & Config (11 files) · Tests & Docs (66 files)


## 4. Primary Runtime Flow

GET /api/projects/:id/files/content is handled by GET /api/projects/:id/files/content, which calls guard, getReadyProject, AppError, getDb, getFileContent; along the way it reads files, symbols, relationships, findings. _(`src/app/api/projects/[id]/files/content/route.ts:15`)_

1. **GET /api/projects/:id/files/content** — function at src/app/api/projects/[id]/files/content/route.ts:15 _(`src/app/api/projects/[id]/files/content/route.ts:15`)_
2. **guard** — function at src/lib/api.ts:20 _(`src/lib/api.ts:20`)_
3. **getReadyProject** — function at src/lib/api.ts:34 _(`src/lib/api.ts:34`)_
4. **AppError** — class at src/lib/util/errors.ts:2 _(`src/lib/util/errors.ts:2`)_
5. **getDb** — function at src/lib/db/client.ts:55 _(`src/lib/db/client.ts:55`)_
6. **getFileContent** — function at src/lib/ingest/store.ts:86 _(`src/lib/ingest/store.ts:86`)_
7. **changeImpact** — function at src/lib/map/index.ts:371 _(`src/lib/map/index.ts:371`)_
8. **json** — function at src/lib/api.ts:8 _(`src/lib/api.ts:8`)_
9. **chunks** — function at src/app/api/projects/[id]/files/content/route.ts:13 _(`src/app/api/projects/[id]/files/content/route.ts:13`)_
10. **reads files** — model at src/lib/db/schema.ts:42 _(`src/lib/db/schema.ts:42`)_
11. **reads symbols** — model at src/lib/db/schema.ts:82 _(`src/lib/db/schema.ts:82`)_
12. **reads relationships** — model at src/lib/db/schema.ts:110 _(`src/lib/db/schema.ts:110`)_
13. **reads findings** — model at src/lib/db/schema.ts:128 _(`src/lib/db/schema.ts:128`)_
14. **fail** — function at src/lib/api.ts:12 _(`src/lib/api.ts:12`)_

## 5. Major Functional Areas

_Each area is a capability delivered by several files working together. This is the macro view; folders are covered next and single files further below._

| Area | What it does | Files | Used by |
| --- | --- | --- | --- |
| **Testing** | Automated tests, fixtures and mocks. | 60 | Infrastructure & Deployment, Parse, API Layer, Analysis, Data Layer and 9 more |
| **API Layer** | HTTP/RPC endpoints and request handling. | 27 | Testing |
| **Documentation** | Project documentation. | 17 | API Layer, Testing, Export, Deck, Formal and 18 more |
| **User Interface** | Pages, components and client-side state. | 15 | API Layer, File & Media Storage, Reporting & Analytics, Map |
| **Content Ingestion** | Collecting and importing data from external sources. | 13 | Testing, API Layer, Infrastructure & Deployment, Background Jobs, File & Media Storage and 8 more |
| **Infrastructure & Deployment** | Build, deployment and operations. | 12 | Testing, Parse, Deck, Export, Discover and 17 more |
| **Application Core** | Top-level application code. | 11 | No other area depends on it directly |
| **AI Processing** | Language-model prompts, agents and inference. | 11 | Testing, API Layer, Configuration, Review, Documentation and 20 more |
| **Deck** | Code under src/lib/deck/. | 11 | Testing, API Layer, Export, Background Jobs, Graph and 1 more |
| **Parse** | Code under src/lib/parse/. | 10 | Testing, Graph, Analysis, Formal, Review and 1 more |
| **Shared Utilities** | Reusable helpers and shared code. | 8 | API Layer, Testing, User Interface, File & Media Storage, Content Ingestion and 14 more |
| **Export** | Code under src/lib/export/. | 7 | Testing, Infrastructure & Deployment, API Layer, Bundle, Deck and 3 more |
| **Util** | Code under src/lib/util/. | 7 | API Layer, Content Ingestion, Testing, Documentation, Review and 14 more |
| **Configuration** | Runtime configuration and tooling settings. | 6 | Documentation, Testing |
| **Public** | Code under public/. | 5 | No other area depends on it directly |
| **Background Jobs** | Asynchronous and scheduled work. | 5 | Testing, Infrastructure & Deployment, API Layer, File & Media Storage, Application Core and 1 more |
| **Review** | Code under src/lib/review/. | 5 | Testing, Analysis, Formal, Background Jobs, Deck and 1 more |
| **Data Layer** | Schemas, models, migrations and data access. | 4 | Testing, API Layer, Search & Retrieval, Documentation, Background Jobs and 17 more |
| **File & Media Storage** | Uploads and stored media. | 4 | Testing |
| **Analysis** | Code under src/lib/analysis/. | 4 | Testing, Review, Parse, Graph, Deck and 1 more |
| **Discover** | Code under src/lib/discover/. | 4 | Testing, API Layer, Documentation, Map, Review and 6 more |
| **Formal** | Code under src/lib/formal/. | 4 | Testing, API Layer, Review |
| **Map** | Code under src/lib/map/. | 3 | API Layer, Testing, Export, User Interface, Background Jobs and 4 more |
| **Drizzle** | Code under drizzle/. | 2 | No other area depends on it directly |
| **Reporting & Analytics** | Aggregations, reporting and analytics. | 2 | Testing |
| **Search & Retrieval** | Indexing and querying content. | 2 | Testing, Ask, Documentation, Bundle, Infrastructure & Deployment and 3 more |
| **Bundle** | Code under src/lib/bundle/. | 2 | Testing, API Layer, File & Media Storage |
| **Graph** | Code under src/lib/graph/. | 2 | Testing, Documentation, Review, Discover, Analysis and 2 more |
| **Ask** | Code under src/lib/ask/. | 1 | API Layer, Infrastructure & Deployment, Testing |

**Folders:**

| Folder | Files | What it is for |
| --- | --- | --- |
| `drizzle/` | 3 | 2 configuration, 1 schema. It spans the Data Layer, Drizzle functional areas. |
| `drizzle/meta/` | 2 | 2 configuration. It sits inside the Drizzle functional area. |
| `fixtures/sample-shop/` | 4 | 4 test. It sits inside the Testing functional area. |
| `scripts/` | 7 | 4 service-layer, 2 utility, 1 entry-point. It sits inside the Infrastructure & Deployment functional area. |
| `src/` | 162 | 67 service-layer, 40 API-layer, 18 user-interface. It spans the Data Layer, Configuration, API Layer and 22 more functional… |
| `src/app/` | 41 | 37 API-layer, 1 schema, 1 utility. It spans the Data Layer, Configuration, API Layer and 6 more functional areas. It serves GET… |
| `src/app/api/` | 27 | 26 API-layer, 1 schema. It spans the Data Layer, Configuration, API Layer and 4 more functional areas. It serves GET… |
| `src/app/api/ai/` | 2 | 1 schema, 1 API-layer. It spans the Data Layer, Configuration functional areas. It serves GET /api/ai/models, GET… |
| `src/app/api/jobs/[id]/` | 2 | 2 API-layer. It sits inside the Background Jobs functional area. It serves GET /api/jobs/:id, POST /api/jobs/:id/cancel. |
| `src/app/api/projects/` | 21 | 21 API-layer. It spans the API Layer, File & Media Storage, Reporting & Analytics and 1 more functional areas. It serves GET… |
| `src/app/api/projects/[id]/` | 17 | 17 API-layer. It spans the API Layer, File & Media Storage, Reporting & Analytics and 1 more functional areas. It serves DELETE… |
| `src/app/api/projects/[id]/files/` | 2 | 2 API-layer. It sits inside the File & Media Storage functional area. It serves GET /api/projects/:id/files, GET… |
| `src/app/p/[id]/` | 11 | 10 API-layer, 1 user-interface. It spans the API Layer, File & Media Storage, User Interface and 1 more functional areas. It… |
| `src/components/` | 14 | 14 user-interface. It sits inside the User Interface functional area. |

## 6. Data Flow


### GET /path

```text
GET /path
   ↓
lineAt
   ↓
callArgs
   ↓
isInlineFn
   ↓
reads symbols
   ↓
jobs.push
   ↓
split
   ↓
trim
```
GET /path is handled by GET /path, which calls lineAt, callArgs, isInlineFn, jobs.push, split; along the way it reads symbols. _(`src/lib/discover/detect.ts:315`)_

Data touched: symbols; external: none.

### GET /api/ai/models

```text
GET /api/ai/models
   ↓
guard
   ↓
AppError
   ↓
json
   ↓
listModels
   ↓
fail
   ↓
resolveModel
   ↓
providerConfigured
   ↓
explainAIError
   ↓
cacheKey
   ↓
split
   ↓
fetchCatalogue
   ↓
isAppError
   ↓
scrubToken
```
GET /api/ai/models is handled by GET /api/ai/models, which calls guard, AppError, json, listModels, fail. _(`src/app/api/ai/models/route.ts:9`)_

### GET /api/ai/settings

```text
GET /api/ai/settings
   ↓
guard
   ↓
json
   ↓
view
   ↓
fail
   ↓
readSettings
   ↓
providerStatus
   ↓
providerConfigured
   ↓
resolveModel
   ↓
runtimeKind
   ↓
resolveEmbeddingModel
   ↓
endpoint
   ↓
selectedProvider
   ↓
isAppError
```
GET /api/ai/settings is handled by GET /api/ai/settings, which calls guard, json, view, fail, readSettings. _(`src/app/api/ai/settings/route.ts:38`)_

### PUT /api/ai/settings

```text
PUT /api/ai/settings
   ↓
guard
   ↓
AppError
   ↓
json
   ↓
updateSettings
   ↓
resetProviderCache
   ↓
checkProvider
   ↓
view
   ↓
fail
   ↓
readSettings
   ↓
settingsPath
   ↓
withDeadline
   ↓
explainAIError
   ↓
providerStatus
```
PUT /api/ai/settings is handled by PUT /api/ai/settings, which calls guard, AppError, json, updateSettings, resetProviderCache. _(`src/app/api/ai/settings/route.ts:43`)_

### POST /api/github/validate

```text
POST /api/github/validate
   ↓
guard
   ↓
json
   ↓
AppError
   ↓
parseGitHubUrl
   ↓
fetchGitHubMetadata
   ↓
trim
   ↓
fail
   ↓
split
   ↓
isAppError
   ↓
scrubToken
```
POST /api/github/validate is handled by POST /api/github/validate, which calls guard, json, AppError, parseGitHubUrl, fetchGitHubMetadata. _(`src/app/api/github/validate/route.ts:10`)_

### GET /api/jobs/:id

```text
GET /api/jobs/:id
   ↓
guard
   ↓
getJob
   ↓
AppError
   ↓
json
   ↓
fail
   ↓
getDb
   ↓
reads jobs
   ↓
isAppError
   ↓
scrubToken
   ↓
openDatabase
```
GET /api/jobs/:id is handled by GET /api/jobs/:id, which calls guard, getJob, AppError, json, fail; along the way it reads jobs. _(`src/app/api/jobs/[id]/route.ts:8`)_

Data touched: jobs; external: none.

### POST /api/jobs/:id/cancel

```text
POST /api/jobs/:id/cancel
   ↓
guard
   ↓
requestCancel
   ↓
AppError
   ↓
json
   ↓
fail
   ↓
getDb
   ↓
getJob
   ↓
isAppError
   ↓
scrubToken
   ↓
openDatabase
   ↓
reads jobs
```
POST /api/jobs/:id/cancel is handled by POST /api/jobs/:id/cancel, which calls guard, requestCancel, AppError, json, fail; along the way it reads jobs. _(`src/app/api/jobs/[id]/cancel/route.ts:8`)_

Data touched: jobs; external: none.

### GET /api/projects

```text
GET /api/projects
   ↓
guard
   ↓
getDb
   ↓
json
   ↓
reads projects
   ↓
fail
   ↓
openDatabase
   ↓
isAppError
   ↓
scrubToken
   ↓
migrationsFolder
```
GET /api/projects is handled by GET /api/projects, which calls guard, getDb, json, fail, openDatabase; along the way it reads projects. _(`src/app/api/projects/route.ts:7`)_

Data touched: projects; external: none.

### DELETE /api/projects/:id

```text
DELETE /api/projects/:id
   ↓
guard
   ↓
getProject
   ↓
listJobs
   ↓
requestCancel
   ↓
deleteProject
   ↓
json
   ↓
fail
   ↓
getDb
   ↓
AppError
   ↓
reads projects
   ↓
reads jobs
   ↓
getJob
   ↓
isAppError
```
DELETE /api/projects/:id is handled by DELETE /api/projects/:id, which calls guard, getProject, listJobs, requestCancel, deleteProject; along the way it reads projects, jobs. _(`src/app/api/projects/[id]/route.ts:15`)_

Data touched: projects, jobs; external: none.

### GET /api/projects/:id

```text
GET /api/projects/:id
   ↓
guard
   ↓
json
   ↓
projectSummary
   ↓
getProject
   ↓
fail
   ↓
getDb
   ↓
reads jobs
   ↓
AppError
   ↓
reads projects
   ↓
isAppError
   ↓
scrubToken
   ↓
openDatabase
```
GET /api/projects/:id is handled by GET /api/projects/:id, which calls guard, json, projectSummary, getProject, fail; along the way it reads jobs, projects. _(`src/app/api/projects/[id]/route.ts:8`)_

Data touched: jobs, projects; external: none.

### POST /api/projects/:id/analyze

```text
POST /api/projects/:id/analyze
   ↓
guard
   ↓
getProject
   ↓
getDb
   ↓
decryptSecret
   ↓
parseGitHubUrl
   ↓
fetchGitHubMetadata
   ↓
createPendingProject
   ↓
enqueueAnalysis
   ↓
json
   ↓
projectSummary
   ↓
reads credentials
   ↓
reads projects
   ↓
fail
```
POST /api/projects/:id/analyze is handled by POST /api/projects/:id/analyze, which calls guard, getProject, getDb, decryptSecret, parseGitHubUrl; along the way it reads credentials, projects. _(`src/app/api/projects/[id]/analyze/route.ts:17`)_

Data touched: credentials, projects; external: none.

### GET /api/projects/:id/architecture

```text
GET /api/projects/:id/architecture
   ↓
guard
   ↓
getReadyProject
   ↓
json
   ↓
architectureDiagramText
   ↓
architectureMermaid
   ↓
erMermaid
   ↓
legendText
   ↓
fail
   ↓
AppError
   ↓
getProject
   ↓
glyphFor
   ↓
loadModel
   ↓
box
```
GET /api/projects/:id/architecture is handled by GET /api/projects/:id/architecture, which calls guard, getReadyProject, json, architectureDiagramText, architectureMermaid. _(`src/app/api/projects/[id]/architecture/route.ts:8`)_

### GET /api/projects/:id/ask

```text
GET /api/projects/:id/ask
   ↓
guard
   ↓
getReadyProject
   ↓
json
   ↓
recentQuestions
   ↓
fail
   ↓
AppError
   ↓
getProject
   ↓
getDb
   ↓
reads questions
   ↓
isAppError
   ↓
scrubToken
   ↓
reads projects
   ↓
openDatabase
```
GET /api/projects/:id/ask is handled by GET /api/projects/:id/ask, which calls guard, getReadyProject, json, recentQuestions, fail; along the way it reads questions, projects. _(`src/app/api/projects/[id]/ask/route.ts:11`)_

Data touched: questions, projects; external: none.

### POST /api/projects/:id/ask

```text
POST /api/projects/:id/ask
   ↓
guard
   ↓
getReadyProject
   ↓
json
   ↓
AppError
   ↓
askRepository
   ↓
fail
   ↓
getProject
   ↓
getDb
   ↓
getAIProvider
   ↓
retrieveContext
   ↓
queryTerms
   ↓
UsageMeter
   ↓
tryAnalyze
```
POST /api/projects/:id/ask is handled by POST /api/projects/:id/ask, which calls guard, getReadyProject, json, AppError, askRepository. _(`src/app/api/projects/[id]/ask/route.ts:19`)_

### GET /api/projects/:id/deck

```text
GET /api/projects/:id/deck
   ↓
guard
   ↓
getReadyProject
   ↓
json
   ↓
deckOutline
   ↓
isDeckFormat
   ↓
AppError
   ↓
exportDeck
   ↓
htmlSecurityHeaders
   ↓
fail
   ↓
getProject
   ↓
ensureDeckContent
   ↓
layoutDeck
   ↓
getDb
```
GET /api/projects/:id/deck is handled by GET /api/projects/:id/deck, which calls guard, getReadyProject, json, deckOutline, isDeckFormat. _(`src/app/api/projects/[id]/deck/route.ts:14`)_

## 7. API Architecture

44 route(s) were detected across Next.js, Express-style: 33 API and 11 page routes. _(`src/app/page.tsx:20`, `src/app/api/ai/models/route.ts:9`, `src/app/api/ai/settings/route.ts:38`)_

0 route(s) show an authentication or authorization check near their definition; 33 API route(s) show none, which means either the check lives in shared middleware or the route is open.

| Method | Route | Handler | Authentication | Kind | Location |
| --- | --- | --- | --- | --- | --- |
| GET | `/` | uploadWithProgress | Not visible | page · Next.js | `src/app/page.tsx:20` |
| GET | `/api/ai/models` | GET (route handler) | Not visible | api · Next.js | `src/app/api/ai/models/route.ts:9` |
| GET | `/api/ai/settings` | GET (route handler) | Not visible | api · Next.js | `src/app/api/ai/settings/route.ts:38` |
| PUT | `/api/ai/settings` | PUT (route handler) | Not visible | api · Next.js | `src/app/api/ai/settings/route.ts:43` |
| POST | `/api/github/validate` | POST (route handler) | Not visible | api · Next.js | `src/app/api/github/validate/route.ts:10` |
| GET | `/api/jobs/:id` | GET (route handler) | Not visible | api · Next.js | `src/app/api/jobs/[id]/route.ts:8` |
| POST | `/api/jobs/:id/cancel` | POST (route handler) | Not visible | api · Next.js | `src/app/api/jobs/[id]/cancel/route.ts:8` |
| GET | `/api/projects` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/route.ts:7` |
| DELETE | `/api/projects/:id` | DELETE (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/route.ts:15` |
| GET | `/api/projects/:id` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/route.ts:8` |
| POST | `/api/projects/:id/analyze` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/analyze/route.ts:17` |
| GET | `/api/projects/:id/architecture` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/architecture/route.ts:8` |
| GET | `/api/projects/:id/ask` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/ask/route.ts:11` |
| POST | `/api/projects/:id/ask` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/ask/route.ts:19` |
| GET | `/api/projects/:id/deck` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/deck/route.ts:14` |
| GET | `/api/projects/:id/explain` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/explain/route.ts:27` |
| POST | `/api/projects/:id/explain` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/explain/route.ts:48` |
| GET | `/api/projects/:id/export` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/export/route.ts:16` |
| GET | `/api/projects/:id/files` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/files/route.ts:9` |
| GET | `/api/projects/:id/files/content` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/files/content/route.ts:15` |
| GET | `/api/projects/:id/findings` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/findings/route.ts:13` |
| GET | `/api/projects/:id/formal` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/formal/route.ts:8` |
| GET | `/api/projects/:id/graph` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/graph/route.ts:9` |
| GET | `/api/projects/:id/impact` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/impact/route.ts:8` |
| GET | `/api/projects/:id/overview` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/overview/route.ts:12` |
| GET | `/api/projects/:id/report` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/report/route.ts:12` |
| GET | `/api/projects/:id/search` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/search/route.ts:8` |
| GET | `/api/projects/:id/symbols/:symbolId` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/symbols/[symbolId]/route.ts:13` |
| POST | `/api/projects/github` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/github/route.ts:16` |
| POST | `/api/projects/import-bundle` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/import-bundle/route.ts:16` |
| POST | `/api/projects/upload` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/upload/route.ts:16` |
| GET | `/api/status` | GET (route handler) | Not visible | api · Next.js | `src/app/api/status/route.ts:32` |
| GET | `/p/:id` | OverviewPage | Not visible | page · Next.js | `src/app/p/[id]/page.tsx:27` |
| GET | `/p/:id/architecture` | ArchitecturePage | Not visible | page · Next.js | `src/app/p/[id]/architecture/page.tsx:16` |
| GET | `/p/:id/ask` | Cite | Not visible | page · Next.js | `src/app/p/[id]/ask/page.tsx:20` |
| GET | `/p/:id/deck` | DeckPage | Not visible | page · Next.js | `src/app/p/[id]/deck/page.tsx:11` |
| GET | `/p/:id/explain` | Origin | Not visible | page · Next.js | `src/app/p/[id]/explain/page.tsx:13` |
| GET | `/p/:id/files` | Splitter | Not visible | page · Next.js | `src/app/p/[id]/files/page.tsx:36` |
| GET | `/p/:id/map` | ImpactPanel | Not visible | page · Next.js | `src/app/p/[id]/map/page.tsx:19` |
| GET | `/p/:id/proofs` | Property | Not visible | page · Next.js | `src/app/p/[id]/proofs/page.tsx:20` |


## 8. Data Architecture

12 data model(s) were found using Drizzle + SQL table projects (drizzle/0000_robust_hawkeye.sql:117), Drizzle + SQL table credentials (drizzle/0000_robust_hawkeye.sql:7), Drizzle + SQL table blobs (drizzle/0000_robust_hawkeye.sql:1), Drizzle + SQL table files (drizzle/0000_robust_hawkeye.sql:20) and 8 more. _(`src/lib/db/schema.ts:4-26`, `src/lib/db/schema.ts:29-33`, `src/lib/db/schema.ts:36-40`)_


## 9. External Integrations

| Service | Category | Where used | Why | If unavailable |
| --- | --- | --- | --- | --- |
| Anthropic | ai | `package.json`, `src/lib/ai/anthropic.ts:1`, `src/lib/config.ts:51` | language model inference | AI-generated features stop producing output |
| OpenAI | ai | `src/lib/config.ts:61`, `src/lib/config.ts:60`, `src/lib/config.ts:49` | language model inference and embeddings | AI-generated features stop producing output |
| SQLite | database | `package.json`, `src/lib/db/client.ts:1` | embedded relational storage | persisted reads and writes fail |
| GitHub API | developer-platform | `src/lib/config.ts:81`, `src/lib/config.ts:80` | repository and identity integration | GitHub-backed features fail |

## 10. Infrastructure & Deployment

Deployment and operations assets: GitHub Actions, Docker, Docker Compose. _(`.github/workflows/ci.yml`, `Dockerfile`, `docker-compose.yml`)_

Network ports referenced: 3003, 3211, 4599. _(`Dockerfile:58`, `playwright.config.ts:5`)_

72 environment variable(s) configure the application, 6 of which look sensitive (names only: ANTHROPIC_API_KEY, BRODY_URL, CREDENTIAL_SECRET, GITHUB_TOKEN, OPENAI_API_KEY, OPENAI_BASE_URL).


**Configuration (variable names only; values are never exported):**

| Variable | Sensitive | Read in | Declared in |
| --- | --- | --- | --- |
| `AI_CONCURRENCY` | no |  | .env.example |
| `AI_EMBEDDING_MODEL` | no | src/lib/config.ts:62 | .env.example |
| `AI_MAX_FILES_EXPLAINED` | no |  | .env.example |
| `AI_MAX_FILES_REVIEWED` | no |  | .env.example |
| `AI_MAX_SYMBOLS_EXPLAINED` | no |  | .env.example |
| `AI_MODEL` | no | src/lib/config.ts:50 |  |
| `AI_PRICING` | no | src/lib/ai/pricing.ts:62 |  |
| `AI_PROVIDER` | no | src/lib/config.ts:42 | .env.example |
| `AI_REFUSAL_FALLBACKS` | no | src/lib/ai/anthropic.ts:33 | .env.example |
| `AI_SETTINGS_PATH` | no | src/lib/ai/settings.ts:40 |  |
| `ALLOWED_HOSTS` | no | src/proxy.ts:9 | .env.example, docker-compose.yml |
| `ANTHROPIC_API_KEY` | yes | src/lib/config.ts:51 | .env.example |
| `ANTHROPIC_MODEL` | no | src/lib/config.ts:48 |  |
| `ANTHROPIC_WORKSPACE_ID` | no | src/lib/config.ts:53 | .env.example |
| `BRODY_BROWSER` | no | scripts/brody.sh:47 |  |
| `BRODY_HOST` | no | scripts/brody.sh:18 |  |
| `BRODY_OPEN` | no | scripts/brody.sh:42 |  |
| `BRODY_PARSE_WORKER` | no | src/lib/config.ts:93 |  |
| `BRODY_URL` | yes | src/lib/bundle/launchers.ts:45 |  |
| `BUNDLE_VERSION` | no | src/lib/bundle/index.ts:209 |  |
| `CLOSE_TAG` | no | src/lib/ai/prompt.ts:30 |  |
| `CREDENTIAL_SECRET` | yes | src/lib/config.ts:124 | .env.example |
| `DATABASE_PATH` | no | drizzle.config.ts:7, src/lib/config.ts:24 | .env.example, docker-compose.yml |
| `E2E_MOCK_AI_PORT` | no | playwright.config.ts:26 |  |
| `E2E_PORT` | no | playwright.config.ts:5 |  |
| `ELAN_HOME` | no | src/lib/formal/lean.ts:97 | Dockerfile |
| `EMBEDDED_WORKER` | no | src/instrumentation.ts:3 | .env.example |
| `FORMAL_CONCURRENCY` | no |  | .env.example |
| `FORMAL_MAX_HEARTBEATS` | no |  | .env.example |
| `FORMAL_MAX_REPAIR_ROUNDS` | no |  | .env.example |
| `FORMAL_MAX_TARGETS` | no |  | .env.example |
| `FORMAL_MEMORY_MB` | no |  | .env.example |
| `FORMAL_SANDBOX` | no | src/lib/config.ts:121 |  |
| `FORMAL_TIMEOUT_MS` | no |  | .env.example |
| `FORMAL_VERIFICATION` | no | src/lib/config.ts:108 | .env.example |
| `FORMAL_VERSION` | no | src/lib/formal/index.ts:259 |  |
| `GITHUB_API_BASE` | no | src/lib/config.ts:81 |  |
| `GITHUB_TOKEN` | yes | src/lib/config.ts:80 | .env.example |
| `GO_PATH` | no | src/lib/config.ts:99 |  |
| `LEAN_BIN` | no | src/lib/config.ts:109 | Dockerfile |
| `LEAN_RULES` | no | src/lib/formal/index.ts:110 |  |
| `LEAN_TOOLCHAIN` | no |  | Dockerfile |
| `MAX_FILE_BYTES` | no |  | .env.example |
| `MAX_FILES` | no |  | .env.example |
| `MAX_TOTAL_BYTES` | no |  | .env.example |
| `MAX_UPLOAD_BYTES` | no | next.config.ts:17 | .env.example |
| `MAX_ZIP_ENTRIES` | no |  | .env.example |
| `MAX_ZIP_RATIO` | no |  | .env.example |
| `MENU_WIDTH` | no | src/components/download.tsx:104 |  |
| `MERMAID_ONLOAD` | no | src/lib/export/html.ts:86 |  |
| `NEXT_BUILD_CPUS` | no | next.config.ts:19 |  |
| `NEXT_RUNTIME` | no | src/instrumentation.ts:3 |  |
| `NEXT_TELEMETRY_DISABLED` | no |  | Dockerfile |
| `NODE_ENV` | no |  | Dockerfile |
| `OPEN_TAG` | no | src/lib/ai/prompt.ts:30 |  |
| `OPENAI_API_KEY` | yes | src/lib/config.ts:61 | .env.example |
| `OPENAI_BASE_URL` | yes | src/lib/config.ts:60 | .env.example |
| `OPENAI_MODEL` | no | src/lib/config.ts:49 |  |
| `PARSE_WORKER_MIN_FILES` | no | src/lib/config.ts:92 |  |
| `PARSE_WORKERS` | no | src/lib/config.ts:91 |  |

## 11. Testing Strategy

60 test file(s): 13 e2e, 17 fixture, 27 unit, 1 integration, 2 helper; frameworks: Vitest, Playwright. _(`e2e/ai-settings.spec.ts`, `e2e/bundle.spec.ts`)_

Important files with no test referencing them include src/components/ui.tsx. _(`src/components/ui.tsx`)_


## 12. Security Model

Authentication: no mechanism detected. 33 of 33 API route(s) have no visible access check.

Secrets: 11 likely secret value(s) were found in source (redacted in this report). _(`e2e/bundle.spec.ts:77`, `fixtures/sample-shop/src/config.ts:7`)_

8 security finding(s) were recorded: 0 critical/high.


## 13. Code Review

25 finding(s): 0 critical, 0 high, 8 medium, 17 low, 0 informational. 25 from static analyzers, 0 AI-inferred (0 need verification).

By category: Maintainability 16 · Security 8 · Testing 1

| ID | Severity | Finding | Where | Fix |
| --- | --- | --- | --- | --- |
| MNT-001 | Medium | High cyclomatic complexity in Home (110) | src/app/page.tsx:52 | Simplify with early returns, lookup tables or smaller functions, and add tests covering each branch. |
| MNT-002 | Medium | High cyclomatic complexity in buildDeckContent (123) | src/lib/deck/content.ts:88 | Simplify with early returns, lookup tables or smaller functions, and add tests covering each branch. |
| MNT-003 | Medium | High cyclomatic complexity in detectRoutes (190) | src/lib/discover/detect.ts:250 | Simplify with early returns, lookup tables or smaller functions, and add tests covering each branch. |
| MNT-004 | Medium | High cyclomatic complexity in detectEntryPoints (100) | src/lib/discover/detect.ts:492 | Simplify with early returns, lookup tables or smaller functions, and add tests covering each branch. |
| MNT-005 | Medium | High cyclomatic complexity in enhanceWithAI (107) | src/lib/docs/ai.ts:80 | Simplify with early returns, lookup tables or smaller functions, and add tests covering each branch. |
| MNT-006 | Medium | High cyclomatic complexity in buildMarkdown (109) | src/lib/export/markdown.ts:63 | Simplify with early returns, lookup tables or smaller functions, and add tests covering each branch. |
| MNT-007 | Medium | High cyclomatic complexity in buildGraph (156) | src/lib/graph/build.ts:70 | Simplify with early returns, lookup tables or smaller functions, and add tests covering each branch. |
| MNT-008 | Medium | High cyclomatic complexity in extractTsJs (166) | src/lib/parse/extract.ts:166 | Simplify with early returns, lookup tables or smaller functions, and add tests covering each branch. |
| MNT-009 | Low | Very long component: Home (278 lines) | src/app/page.tsx:52 | Extract cohesive steps into named helper functions. |
| MNT-010 | Low | Very long function: buildDeckContent (248 lines) | src/lib/deck/content.ts:88 | Extract cohesive steps into named helper functions. |
| MNT-011 | Low | Very long function: detectRoutes (190 lines) | src/lib/discover/detect.ts:250 | Extract cohesive steps into named helper functions. |
| MNT-012 | Low | Very long function: enhanceWithAI (244 lines) | src/lib/docs/ai.ts:80 | Extract cohesive steps into named helper functions. |
| MNT-013 | Low | Very long function: buildMarkdown (199 lines) | src/lib/export/markdown.ts:63 | Extract cohesive steps into named helper functions. |
| MNT-014 | Low | Very long function: buildGraph (292 lines) | src/lib/graph/build.ts:70 | Extract cohesive steps into named helper functions. |
| MNT-015 | Low | Very long function: layoutMap (185 lines) | src/lib/map/layout.ts:71 | Extract cohesive steps into named helper functions. |
| MNT-016 | Low | Very long function: extractTsJs (198 lines) | src/lib/parse/extract.ts:166 | Extract cohesive steps into named helper functions. |
| SEC-001 | Low | Secret-like value in test or fixture file e2e/bundle.spec.ts | e2e/bundle.spec.ts:77 | Rotate the credential immediately, remove it from history, and load it from environment configuration or a… |
| SEC-002 | Low | Secret-like value in test or fixture file fixtures/sample-shop/src/config.ts | fixtures/sample-shop/src/config.ts:7 | Rotate the credential immediately, remove it from history, and load it from environment configuration or a… |
| SEC-003 | Low | None of the 33 API routes has an authentication check | src/app/api/ai/models/route.ts:9 | Put the service behind an authenticating reverse proxy, or add authentication and authorization to the… |
| SEC-004 | Low | Secret-like value in test or fixture file tests/ai.test.ts | tests/ai.test.ts:158 | Rotate the credential immediately, remove it from history, and load it from environment configuration or a… |
| SEC-005 | Low | Secret-like value in test or fixture file tests/api.test.ts | tests/api.test.ts:117 | Rotate the credential immediately, remove it from history, and load it from environment configuration or a… |
| SEC-006 | Low | Secret-like value in test or fixture file tests/bundle.test.ts | tests/bundle.test.ts:26 | Rotate the credential immediately, remove it from history, and load it from environment configuration or a… |
| SEC-007 | Low | Secret-like value in test or fixture file tests/pipeline.test.ts | tests/pipeline.test.ts:87 | Rotate the credential immediately, remove it from history, and load it from environment configuration or a… |
| SEC-008 | Low | Secret-like value in test or fixture file tests/secrets.test.ts | tests/secrets.test.ts:5 | Rotate the credential immediately, remove it from history, and load it from environment configuration or a… |
| TST-001 | Low | 1 important file has no tests | src/components/ui.tsx:1 | Add unit tests for the exported functions and failure paths of these files, starting with the request… |

## 14. Engineering Risks

No critical or high-severity findings were recorded.


## 15. File & Component Explanations

_Each entry explains one file on its own. How groups of files work together is in Major Functional Areas and Folder & Module Explanations._

| File | Role | What it does |
| --- | --- | --- |
| `src/lib/db/client.ts` | data | data-layer TypeScript file in the Data Layer area. It declares 14 functions, 5 variables, 3 types, 1 interface, 1 constant. |
| `src/lib/config.ts` | service | service-layer TypeScript file in the Shared Utilities area. It declares 1 variable, 1 type, 2 functions. |
| `src/lib/db/schema.ts` | schema | TypeScript file in the Data Layer area. It defines the data models projects, credentials, blobs, files and 8 more. It declares 12 models, 7 types, 1… |
| `src/lib/api.ts` | api | API layer TypeScript file in the Shared Utilities area. It declares 7 functions. |
| `src/lib/util/errors.ts` | util | TypeScript file in the Util area. It declares 1 class, 2 functions, 3 propertys, 1 method. |
| `src/lib/ai/index.ts` | ai | TypeScript file in the AI Processing area. It declares 7 functions, 2 interfaces, 1 class, 1 method, 3 variables, 2 propertys. |
| `src/lib/discover/types.ts` | util | TypeScript file in the Discover area. It declares 17 interfaces. |
| `src/lib/docs/types.ts` | util | TypeScript file in the Documentation area. It declares 11 interfaces. |
| `src/lib/graph/build.ts` | service | service-layer TypeScript file in the Graph area. It declares 4 interfaces, 3 functions, 3 constants. |
| `.github/workflows/ci.yml` | infra | infrastructure YAML file in the Infrastructure & Deployment area. It declares 3 jobs. |
| `src/lib/ai/models.ts` | ai | TypeScript file in the AI Processing area. It declares 6 functions, 2 constants, 1 type, 1 interface, 1 variable. |
| `src/lib/docs/ai.ts` | service | service-layer TypeScript file in the Documentation area. It declares 7 functions, 1 interface, 9 variables, 1 constant. |
| `src/lib/ingest/store.ts` | service | service-layer TypeScript file in the Content Ingestion area. It declares 8 functions, 1 interface, 1 type, 1 constant, 2 variables. |
| `src/lib/map/index.ts` | service | service-layer TypeScript file in the Map area. It declares 24 functions, 8 interfaces, 2 variables, 2 constants. |
| `src/lib/jobs/index.ts` | job | background-processing TypeScript file in the Background Jobs area. It declares 9 functions, 13 methods, 2 classs, 5 propertys, 1 constant. |

_The 15 most important of 191 documented files. The Complete Technical Report explains every file._

## 16. Detailed Symbol Explanations

| Symbol | Kind | Purpose | Used by |
| --- | --- | --- | --- |
| `jobs.push` | job | Job jobs.push (no doc comment; role inferred from name and relationships). | 10 callers |
| `split` | function | Function split (no doc comment; role inferred from name and relationships). | 10 callers |
| `trim` | function | Function trim (no doc comment; role inferred from name and relationships). | 10 callers |
| `getDb` | function | Return the open database, opening the configured one on first use. | 10 callers |
| `openDatabase` | function | Function openDatabase (no doc comment; role inferred from name and relationships). | 5 callers |
| `migrationsFolder` | function | Resolve the migrations folder for both source and standalone builds. | 1 caller |
| `files` | model | Data model files. | 10 callers |
| `json` | function | Function json (no doc comment; role inferred from name and relationships). | 10 callers |
| `projects` | model | Projects: one row per ingested codebase (a repository or an upload). | 10 callers |
| `AppError` | class | Application error with an HTTP status and a user-facing, actionable message. | 10 callers |
| `jobs` | model | Data model jobs. | 10 callers |
| `findings` | model | Data model findings. | 10 callers |
| `symbols` | model | Data model symbols. | 10 callers |
| `splitColor` | function | "#RRGGBB" or "#RRGGBBAA" split into the opaque colour and its alpha, for formats that keep them apart. | 8 callers |
| `jobs.verify` | job | Job jobs.verify (no doc comment; role inferred from name and relationships). | 1 caller |

_The 15 most important of 300 documented symbols. The Complete Technical Report explains every one._

## 17. Recommendations

1. Add tests for src/components/ui.tsx, which many files depend on. _(`src/components/ui.tsx`)_

## 18. Detailed Code Map


### 1. Repository Tree

```text
brody/
├── .github/  # build, deployment and operations (1 files)
│   └── workflows/  # infrastructure (1 files)
├── docs/  # project documentation (7 files)
│   ├── validation/
│   └── ARCHITECTURE.md
├── drizzle/
│   ├── meta/  # configuration (2 files)
│   └── 0000_robust_hawkeye.sql
├── e2e/ ○  # automated tests, fixtures and mocks (13 files)
│   ├── ai-settings.spec.ts
│   ├── bundle.spec.ts ○
│   ├── datamodel.spec.ts
│   ├── deck.spec.ts
│   ├── explain.spec.ts
│   ├── home.spec.ts
│   ├── performance.spec.ts
│   ├── progress.spec.ts
│   ├── proofs.spec.ts
│   ├── styling.spec.ts
│   └── … 3 more
├── fixtures/ ○  # automated tests, fixtures and mocks (17 files)
│   └── sample-shop/ ○  # tests (17 files)
├── public/  # unknown (5 files)
│   ├── file.svg
│   ├── globe.svg
│   ├── next.svg
│   ├── vercel.svg
│   └── window.svg
├── scripts/  # build, deployment and operations (7 files)
│   ├── analyze.mts
│   ├── benchmark.mts
│   ├── brody.sh
│   ├── convert.mts
│   ├── validate.sh
│   ├── verify-ai.mts
│   └── worker.mts
├── src/ ●
│   ├── app/ ●  # API layer (42 files)
│   ├── components/ ○  # pages, components and client-side state (14 files)
│   ├── lib/ ●  # reusable helpers and shared code (105 files)
│   ├── instrumentation.ts
│   └── proxy.ts
├── tests/ ○  # automated tests, fixtures and mocks (30 files)
│   ├── helpers/  # reusable helpers and shared code (2 files)
│   ├── ai.test.ts ○
│   ├── analyzers.test.ts
│   ├── api.test.ts ○
│   ├── brief.test.ts
│   ├── bundle.test.ts ○
│   ├── datamodel.test.ts
│   ├── deck.test.ts
│   ├── dual-provider.test.ts
│   ├── exports.test.ts
│   └── … 19 more
├── tools/  # build, deployment and operations (1 files)
│   └── build-worker.mjs
└── … 17 more
```

### 2. Functional Component Map

```text
      ┌──────────────────────────────────────────────┐
      │ ● Entry Points                               │
      ├──────────────────────────────────────────────┤
      │ src/app/layout.tsx (frontend)                │
      │ tools/build-worker.mjs (application)         │
      │ scripts/worker.mts (worker)                  │
      └──────────────────────────────────────────────┘
                             │
                             ▼
      ┌──────────────────────────────────────────────┐
      │ ■ Web / UI Layer                             │
      ├──────────────────────────────────────────────┤
      │ 18 files, 11 pages                           │
      │ Next.js                                      │
      │ React                                        │
      └──────────────────────────────────────────────┘
                             │
                             ▼
      ┌──────────────────────────────────────────────┐
      │ ▲ API Layer                                  │
      ├──────────────────────────────────────────────┤
      │ 33 routes                                    │
      │ Next.js                                      │
      │ Express-style                                │
      └──────────────────────────────────────────────┘
                             │
                             ▼
      ┌──────────────────────────────────────────────┐
      │ ⟳ Background Jobs                            │
      ├──────────────────────────────────────────────┤
      │ 2 files                                      │
      │ scripts/worker.mts                           │
      │ src/lib/jobs/worker.ts                       │
      └──────────────────────────────────────────────┘
                             │
                             ▼
      ┌──────────────────────────────────────────────┐
      │ ◆ Service / Domain Layer                     │
      ├──────────────────────────────────────────────┤
      │ 107 files                                    │
      │ Documentation                                │
      │ Content Ingestion                            │
      │ Infrastructure & Deployment                  │
      └──────────────────────────────────────────────┘
                             │
                     ├───────────────┐
                     ▼               ▼
┌──────────────────────────────────────────────┐  ┌──────────────────────────────────────────────┐
│ ⬢ Data Layer                                 │  │ ★ External Services                          │
├──────────────────────────────────────────────┤  ├──────────────────────────────────────────────┤
│ 12 models                                    │  │ Anthropic (ai)                               │
│ SQLite                                       │  │ OpenAI (ai)                                  │
└──────────────────────────────────────────────┘  │ SQLite (database)                            │
                                                  │ GitHub API (developer-platform)              │
                                                  └──────────────────────────────────────────────┘
```

**Functional-area dependencies:**

- API Layer → Shared Utilities (186 references)
- API Layer → User Interface (176 references)
- Testing → Data Layer (120 references)
- Testing → AI Processing (115 references)
- Testing → Content Ingestion (68 references)
- Testing → Shared Utilities (55 references)
- API Layer → Documentation (51 references)
- API Layer → Map (49 references)
- Testing → Background Jobs (47 references)
- API Layer → Util (44 references)

### 3. Runtime / Data Flow Map

```text
GET /path
  ○ GET /path  (src/lib/discover/detect.ts:250)
    ↓
  ○ lineAt  (src/lib/discover/detect.ts:6)
    ↓
  ○ callArgs  (src/lib/discover/detect.ts:218)
    ↓
  ○ isInlineFn  (src/lib/discover/detect.ts:248)
    ↓
  ⬢ reads symbols  (src/lib/db/schema.ts:82)
    ↓
  ○ jobs.push  (.github/workflows/ci.yml:3)
    ↓
  ○ split  (src/lib/ai/models.ts:67)
    ↓
  ○ trim  (src/lib/docs/ai.ts:404)
```
```text
GET /api/ai/models
  ○ GET /api/ai/models  (src/app/api/ai/models/route.ts:9)
    ↓
  ○ guard  (src/lib/api.ts:20)
    ↓
  ○ AppError  (src/lib/util/errors.ts:2)
    ↓
  ○ json  (src/lib/api.ts:8)
    ↓
  ○ listModels  (src/lib/ai/models.ts:76)
    ↓
  ○ fail  (src/lib/api.ts:12)
    ↓
  ○ resolveModel  (src/lib/ai/settings.ts:135)
    ↓
  ○ providerConfigured  (src/lib/ai/settings.ts:105)
    ↓
  ○ explainAIError  (src/lib/ai/errors.ts:2)
    ↓
  ○ cacheKey  (src/lib/ai/models.ts:53)
    ↓
  ○ split  (src/lib/ai/models.ts:67)
    ↓
  ○ fetchCatalogue  (src/lib/ai/models.ts:62)
    ↓
  ○ isAppError  (src/lib/util/errors.ts:14)
    ↓
  ○ scrubToken  (src/lib/ingest/credentials.ts:36)
```
```text
GET /api/ai/settings
  ○ GET /api/ai/settings  (src/app/api/ai/settings/route.ts:38)
    ↓
  ○ guard  (src/lib/api.ts:20)
    ↓
  ○ json  (src/lib/api.ts:8)
    ↓
  ○ view  (src/app/api/ai/settings/route.ts:21)
    ↓
  ○ fail  (src/lib/api.ts:12)
    ↓
  ○ readSettings  (src/lib/ai/settings.ts:48)
    ↓
  ○ providerStatus  (src/lib/ai/index.ts:56)
    ↓
  ○ providerConfigured  (src/lib/ai/settings.ts:105)
    ↓
  ○ resolveModel  (src/lib/ai/settings.ts:135)
    ↓
  ○ runtimeKind  (src/lib/runtime.ts:5)
    ↓
  ○ resolveEmbeddingModel  (src/lib/ai/settings.ts:149)
    ↓
  ○ endpoint  (src/app/api/ai/settings/route.ts:11)
    ↓
  ○ selectedProvider  (src/lib/ai/settings.ts:120)
    ↓
  ○ isAppError  (src/lib/util/errors.ts:14)
```
```text
PUT /api/ai/settings
  ○ PUT /api/ai/settings  (src/app/api/ai/settings/route.ts:43)
    ↓
  ○ guard  (src/lib/api.ts:20)
    ↓
  ○ AppError  (src/lib/util/errors.ts:2)
    ↓
  ○ json  (src/lib/api.ts:8)
    ↓
  ○ updateSettings  (src/lib/ai/settings.ts:63)
    ↓
  ○ resetProviderCache  (src/lib/ai/index.ts:35)
    ↓
  ○ checkProvider  (src/lib/ai/index.ts:108)
    ↓
  ○ view  (src/app/api/ai/settings/route.ts:21)
    ↓
  ○ fail  (src/lib/api.ts:12)
    ↓
  ○ readSettings  (src/lib/ai/settings.ts:48)
    ↓
  ○ settingsPath  (src/lib/ai/settings.ts:39)
    ↓
  ○ withDeadline  (src/lib/ai/deadline.ts:2)
    ↓
  ○ explainAIError  (src/lib/ai/errors.ts:2)
    ↓
  ○ providerStatus  (src/lib/ai/index.ts:56)
```

### 4. Dependency Map

The 12 most important of 182 source files (the interactive map in the application shows all of them):

- `client.ts`
- `config.ts`
- `schema.ts`
- `api.ts`
- `errors.ts`
- `index.ts`
- `types.ts`
- `types.ts`
- `build.ts`
- `models.ts`
- `ai.ts`
- `store.ts`

### 5. API Map

| Method | Route | Handler | Authentication | Kind | Location |
| --- | --- | --- | --- | --- | --- |
| GET | `/` | uploadWithProgress | Not visible | page · Next.js | `src/app/page.tsx:20` |
| GET | `/api/ai/models` | GET (route handler) | Not visible | api · Next.js | `src/app/api/ai/models/route.ts:9` |
| GET | `/api/ai/settings` | GET (route handler) | Not visible | api · Next.js | `src/app/api/ai/settings/route.ts:38` |
| PUT | `/api/ai/settings` | PUT (route handler) | Not visible | api · Next.js | `src/app/api/ai/settings/route.ts:43` |
| POST | `/api/github/validate` | POST (route handler) | Not visible | api · Next.js | `src/app/api/github/validate/route.ts:10` |
| GET | `/api/jobs/:id` | GET (route handler) | Not visible | api · Next.js | `src/app/api/jobs/[id]/route.ts:8` |
| POST | `/api/jobs/:id/cancel` | POST (route handler) | Not visible | api · Next.js | `src/app/api/jobs/[id]/cancel/route.ts:8` |
| GET | `/api/projects` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/route.ts:7` |
| DELETE | `/api/projects/:id` | DELETE (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/route.ts:15` |
| GET | `/api/projects/:id` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/route.ts:8` |
| POST | `/api/projects/:id/analyze` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/analyze/route.ts:17` |
| GET | `/api/projects/:id/architecture` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/architecture/route.ts:8` |
| GET | `/api/projects/:id/ask` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/ask/route.ts:11` |
| POST | `/api/projects/:id/ask` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/ask/route.ts:19` |
| GET | `/api/projects/:id/deck` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/deck/route.ts:14` |
| GET | `/api/projects/:id/explain` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/explain/route.ts:27` |
| POST | `/api/projects/:id/explain` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/explain/route.ts:48` |
| GET | `/api/projects/:id/export` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/export/route.ts:16` |
| GET | `/api/projects/:id/files` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/files/route.ts:9` |
| GET | `/api/projects/:id/files/content` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/files/content/route.ts:15` |
| GET | `/api/projects/:id/findings` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/findings/route.ts:13` |
| GET | `/api/projects/:id/formal` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/formal/route.ts:8` |
| GET | `/api/projects/:id/graph` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/graph/route.ts:9` |
| GET | `/api/projects/:id/impact` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/impact/route.ts:8` |
| GET | `/api/projects/:id/overview` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/overview/route.ts:12` |
| GET | `/api/projects/:id/report` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/report/route.ts:12` |
| GET | `/api/projects/:id/search` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/search/route.ts:8` |
| GET | `/api/projects/:id/symbols/:symbolId` | GET (route handler) | Not visible | api · Next.js | `src/app/api/projects/[id]/symbols/[symbolId]/route.ts:13` |
| POST | `/api/projects/github` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/github/route.ts:16` |
| POST | `/api/projects/import-bundle` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/import-bundle/route.ts:16` |
| POST | `/api/projects/upload` | POST (route handler) | Not visible | api · Next.js | `src/app/api/projects/upload/route.ts:16` |
| GET | `/api/status` | GET (route handler) | Not visible | api · Next.js | `src/app/api/status/route.ts:32` |
| GET | `/p/:id` | OverviewPage | Not visible | page · Next.js | `src/app/p/[id]/page.tsx:27` |
| GET | `/p/:id/architecture` | ArchitecturePage | Not visible | page · Next.js | `src/app/p/[id]/architecture/page.tsx:16` |
| GET | `/p/:id/ask` | Cite | Not visible | page · Next.js | `src/app/p/[id]/ask/page.tsx:20` |
| GET | `/p/:id/deck` | DeckPage | Not visible | page · Next.js | `src/app/p/[id]/deck/page.tsx:11` |
| GET | `/p/:id/explain` | Origin | Not visible | page · Next.js | `src/app/p/[id]/explain/page.tsx:13` |
| GET | `/p/:id/files` | Splitter | Not visible | page · Next.js | `src/app/p/[id]/files/page.tsx:36` |
| GET | `/p/:id/map` | ImpactPanel | Not visible | page · Next.js | `src/app/p/[id]/map/page.tsx:19` |
| GET | `/p/:id/proofs` | Property | Not visible | page · Next.js | `src/app/p/[id]/proofs/page.tsx:20` |
| GET | `/p/:id/reports` | ReportsPage | Not visible | page · Next.js | `src/app/p/[id]/reports/page.tsx:18` |
| GET | `/p/:id/review` | Diff | Not visible | page · Next.js | `src/app/p/[id]/review/page.tsx:14` |
| GET | `/path` | handler | Not visible | api · Express-style | `src/lib/discover/detect.ts:315` |
| GET | `/x` | GET /x (inline) | Not visible | api · Express-style | `src/lib/parse/extract.ts:328` |


### 6. Data Model Map

| Model | Type | Fields | Points to | Location |
| --- | --- | --- | --- | --- |
| projects | Drizzle + SQL table projects (drizzle/0000_robust_hawkeye.sql:117) | id: text("id").primaryKey(), name: text("name").notNull(), sourceType: text("source_type").notNull(), sourceUrl: text("source_url"), owner: text("owner"), branch: text("branch") | — | `src/lib/db/schema.ts:4` |
| credentials | Drizzle + SQL table credentials (drizzle/0000_robust_hawkeye.sql:7) | projectId: text("project_id").primaryKey(), encrypted: text("encrypted").notNull(), createdAt: integer("created_at").notNull(), project_id, created_at | — | `src/lib/db/schema.ts:29` |
| blobs | Drizzle + SQL table blobs (drizzle/0000_robust_hawkeye.sql:1) | hash: text("hash").primaryKey(), content: text("content").notNull(), size: integer("size").notNull() | — | `src/lib/db/schema.ts:36` |
| files | Drizzle + SQL table files (drizzle/0000_robust_hawkeye.sql:20) | id: text("id").primaryKey(), projectId: text("project_id").notNull(), path: text("path").notNull(), name: text("name").notNull(), directory: text("directory").notNull(), extension: text("extension").notNull() | — | `src/lib/db/schema.ts:42` |
| symbols | Drizzle + SQL table symbols (drizzle/0000_robust_hawkeye.sql:165) | id: text("id").primaryKey(), projectId: text("project_id").notNull(), fileId: text("file_id").notNull(), filePath: text("file_path").notNull(), name: text("name").notNull(), qualifiedName: text("qualified_name").notNull() | — | `src/lib/db/schema.ts:82` |
| relationships | Drizzle + SQL table relationships (drizzle/0000_robust_hawkeye.sql:148) | id: text("id").primaryKey(), projectId: text("project_id").notNull(), kind: text("kind").notNull(), sourceType: text("source_type").notNull(), sourceId: text("source_id").notNull(), targetType: text("target_type").notNull() | — | `src/lib/db/schema.ts:110` |
| findings | Drizzle + SQL table findings (drizzle/0000_robust_hawkeye.sql:54) | id: text("id").primaryKey(), projectId: text("project_id").notNull(), code: text("code").notNull(), title: text("title").notNull(), category: text("category").notNull(), severity: text("severity").notNull() | — | `src/lib/db/schema.ts:128` |
| jobs | Drizzle + SQL table jobs (drizzle/0000_robust_hawkeye.sql:93) | id: text("id").primaryKey(), projectId: text("project_id").notNull(), status: text("status").notNull(), currentStage: text("current_stage"), error: text("error"), createdAt: integer("created_at").notNull() | — | `src/lib/db/schema.ts:159` |
| parseCache | Drizzle + SQL table parse_cache (drizzle/0000_robust_hawkeye.sql:111) | key: text("key").primaryKey(), payload: text("payload").notNull(), createdAt: integer("created_at").notNull(), created_at | — | `src/lib/db/schema.ts:182` |
| explainCache | Drizzle + SQL table explain_cache (drizzle/0000_robust_hawkeye.sql:13) | key: text("key").primaryKey(), kind: text("kind").notNull(), createdAt: integer("created_at").notNull(), payload, created_at | — | `src/lib/db/schema.ts:189` |
| indexEntries | Drizzle + SQL table index_entries (drizzle/0000_robust_hawkeye.sql:80) | projectId: text("project_id").notNull(), kind: text("kind").notNull(), refId: text("ref_id").notNull(), filePath: text("file_path"), title: text("title").notNull(), terms: text("terms").notNull() | — | `src/lib/db/schema.ts:197` |
| questions | Drizzle + SQL table questions (drizzle/0000_robust_hawkeye.sql:139) | id: text("id").primaryKey(), projectId: text("project_id").notNull(), question: text("question").notNull(), createdAt: integer("created_at").notNull(), answer, project_id | — | `src/lib/db/schema.ts:212` |

### 7. Test Map

| Test file | Kind | Framework | Exercises |
| --- | --- | --- | --- |
| `e2e/ai-settings.spec.ts` | e2e | Playwright | .github/workflows/ci.yml, src/lib/deck/pdf.ts, src/lib/api.ts, src/components/ai-settings.tsx |
| `e2e/bundle.spec.ts` | e2e | Playwright | src/lib/ai/models.ts, src/lib/api.ts |
| `e2e/datamodel.spec.ts` | e2e | Playwright | not resolved |
| `e2e/deck.spec.ts` | e2e | Playwright | src/lib/ai/models.ts, src/lib/api.ts, src/components/deck.tsx |
| `e2e/explain.spec.ts` | e2e | Playwright | src/lib/deck/pdf.ts |
| `e2e/home.spec.ts` | e2e | Playwright | src/lib/deck/pdf.ts |
| `e2e/performance.spec.ts` | e2e | Playwright | .github/workflows/ci.yml, src/lib/jobs/index.ts |
| `e2e/progress.spec.ts` | e2e | Playwright | src/lib/ai/openai.ts, src/lib/ai/models.ts, src/lib/api.ts |
| `e2e/proofs.spec.ts` | e2e | Playwright | src/lib/ai/openai.ts, .github/workflows/ci.yml |
| `e2e/styling.spec.ts` | e2e | Playwright | .github/workflows/ci.yml |
| `e2e/theme.spec.ts` | e2e | Playwright | src/lib/deck/theme.ts |
| `e2e/usage.spec.ts` | e2e | Playwright | src/components/usage.tsx |
| `e2e/workflow.spec.ts` | e2e | Playwright | src/lib/deck/pdf.ts |
| `fixtures/sample-shop/.env.example` | fixture |  | .env.example |
| `fixtures/sample-shop/.gitignore` | fixture |  | .dockerignore |

**Important components with no tests:**

- `src/components/ui.tsx` — high-importance ui file with no test referencing it

### 8. External Integration Map

```text
★ Anthropic (ai)
     ⇠ package.json, src/lib/ai/anthropic.ts:1, src/lib/config.ts:51
★ OpenAI (ai)
     ⇠ src/lib/config.ts:61, src/lib/config.ts:60, src/lib/config.ts:49
★ SQLite (database)
     ⇠ package.json, src/lib/db/client.ts:1
★ GitHub API (developer-platform)
     ⇠ src/lib/config.ts:81, src/lib/config.ts:80
```

### 9. High-Risk Component Map

| Risk | File | Role | Importance | Findings |
| --- | --- | --- | --- | --- |
| ● medium | `src/lib/graph/build.ts` | service | 0.31 | 2 |
| ● medium | `src/lib/docs/ai.ts` | service | 0.29 | 2 |
| ● medium | `src/lib/export/markdown.ts` | service | 0.08 | 2 |
| ● medium | `src/lib/discover/detect.ts` | api | 0.06 | 3 |
| ● medium | `src/lib/deck/content.ts` | service | 0.05 | 2 |
| ● medium | `src/lib/parse/extract.ts` | api | 0.05 | 2 |
| ● medium | `src/app/page.tsx` | api | 0.03 | 2 |
| ○ low | `src/components/ui.tsx` | ui | 0.19 | 1 |

### 10. Change Impact Relationships

**split** (src/lib/ai/models.ts:67) — Changing split can affect 201 upstream components, including 8 routes, and depends on 0 downstream components. 25 test file(s) exercise this code.
```text
split
   ↓ used by
GET

split
   ↓ used by
GET

split
   ↓ used by
Cite

split
   ↓ used by
CollectionBody

split
   ↓ used by
Code
```
**trim** (src/lib/docs/ai.ts:404) — Changing trim can affect 201 upstream components, including 12 routes, and depends on 0 downstream components. 18 test file(s) exercise this code.
```text
trim
   ↓ used by
POST

trim
   ↓ used by
GET

trim
   ↓ used by
BodySchema

trim
   ↓ used by
GET

trim
   ↓ used by
GET
```

### 11. Legend

```text
LEGEND

● Application Entry Point
◆ Service
■ UI Component
▲ API Endpoint
⬢ Data Model
○ Utility
★ External Service
T Test
C Configuration
⟳ Background Job
▣ Infrastructure

→ Calls
⇢ Imports
⟶ Data flow
⤷ Writes to
⤶ Reads from
⋯ Optional dependency

Risk:
! Critical
▲ High
● Medium
○ Low
```

## 19. Legend

```text
LEGEND

● Application Entry Point
◆ Service
■ UI Component
▲ API Endpoint
⬢ Data Model
○ Utility
★ External Service
T Test
C Configuration
⟳ Background Job
▣ Infrastructure

→ Calls
⇢ Imports
⟶ Data flow
⤷ Writes to
⤶ Reads from
⋯ Optional dependency

Risk:
! Critical
▲ High
● Medium
○ Low
```
