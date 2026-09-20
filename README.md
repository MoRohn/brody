# Brody: repository intelligence, code review and code map

Brody turns source code into system understanding. Give it a file, a folder, a ZIP or a GitHub repository. It indexes the code with real parsers, builds a symbol and dependency graph, reviews it with deterministic analyzers and (optionally) AI, verifies every finding against the source, writes a hierarchical explanation of what the system does, and draws an interactive code map.

```
INGEST → NORMALIZE → PARSE → INDEX → SYMBOL GRAPH → DEPENDENCY GRAPH → RETRIEVE → ANALYZE → VERIFY → SYNTHESIZE → DOCUMENT → VISUALIZE
```

An LLM never receives "the whole repo". It reasons over structured repository knowledge (symbols, call graph, routes, models, retrieved excerpts) and everything it says must cite lines that exist.

## Quick start

### Start Brody with one command

```bash
start brody      # builds if needed, launches in the background, prints http://brody:3003
brody stop       # also: brody status | restart | logs | open
```

`start brody` and `brody` are small commands in `~/.local/bin` that point at `scripts/brody.sh`. To install them on another machine:

```bash
ln -s "$(pwd)/scripts/brody.sh" ~/.local/bin/brody
```

Inside the repository, `npm run brody` does the same as `brody start`. Logs are in `data/brody.log`.

### Address

Brody is served at **http://brody:3003** and refuses requests addressed to `localhost` or any other hostname (`ALLOWED_HOSTS`). Make the name resolve once:

```bash
echo "127.0.0.1 brody" | sudo tee -a /etc/hosts
```

Change the port with `PORT`; set `ALLOWED_HOSTS=` (empty) to disable the host check.

### Docker (one command)

```bash
cp .env.example .env        # optional: add ANTHROPIC_API_KEY to enable AI features
docker compose up --build   # http://brody:3003
```

The image is Node 24, runs as a non-root user with all capabilities dropped, and stores its SQLite database in the `brody-data` volume. Ruff is installed for Python analysis. Building the image needs roughly 1.5 GB of free RAM in the Docker VM (default Docker Desktop settings work).

### Local development

Requires Node 24+ (optionally `ruff` and `python3` on PATH for Python analysis).

```bash
npm install
cp .env.example .env        # optional
npm run dev                 # http://brody:3003
```

Then upload `fixtures/sample-shop` (or a ZIP of it) to see the whole workflow on a small, deliberately flawed shop backend.

### Command line

```bash
npm run analyze -- ./path/to/project --out ./report   # writes CODEBASE_REPORT.md, report.pdf, report.docx, report.html, report.json
npm run convert -- notes.md                            # any Markdown file to PDF and Word with the same renderers
npm run benchmark -- 200 1000 3000                     # pipeline and export timings on synthetic repositories
npm run worker                                         # optional standalone job worker (set EMBEDDED_WORKER=off on the web server)
npm run verify:ai                                      # live check of your AI provider on the sample repo (billable)
```

## What you get

| Area | What it does |
| --- | --- |
| **Intake** | One **Select your code** section with two collapsible options: **Upload** (files, a folder or a ZIP; open by default) and **Import repository** (GitHub, with branch, tag, commit and an optional token for private repos). Repository metadata (owner, branch, latest commit, languages, file count, size) is shown before analysis. Long waits show a spinner, a moving progress bar, the current step and live timers. |
| **Overview** | What the system is, what it does, how it works, its technology, statistics and a summary of the engineering review, answerable in about 30 seconds. No meaningless quality score. |
| **Code Review** | Findings with ID (`SEC-004`), severity, confidence, file and line range, evidence, plain-English behaviour, why it matters, business impact, remediation and a suggested patch that is validated against the real file. Filter by severity, category, source, status, confidence and functional area. |
| **System Explanation** | Explanations at four zoom levels, each on its own tab so scales never blur. **Whole system:** executive summary, architecture, runtime flow, data flows, API and data architecture, integrations, infrastructure, testing, security, risks and recommendations. **Groups of files:** functional areas *and* folders, each explaining how its files work together (who coordinates, what is shared, what the rest of the system uses, what it depends on), with a table that links down to each file. You can also pick **any set of files or folders** and have them explained together, structurally at once or written by the AI. **Single files:** one file at a time, with links up to its folder and area. **Symbols:** functions, classes and endpoints. Evidence links open the code. |
| **Architecture** | Layer map, entry points, API map, data-model map with ER diagram, external services (what fails if they are down), internal and external dependencies, environment variables (names only), ports, feature flags, CI and infrastructure, test map. |
| **Code Map** | Interactive graph at three levels (functional areas → files → one symbol) with drill-down, a consistent legend, risk marks, Mermaid export and a **change-impact** panel: "if I modify this, what could I affect?" |
| **Files** | Three-pane explorer: file tree, source with symbol and finding markers, and a code-intelligence panel (purpose, symbols, callers, callees, data access, tests, findings, impact). Panels are resizable. |
| **Ask Repository** | Structural questions ("who depends on X?", "what writes to `orders`?", "what happens after `POST /checkout`?", "where is X defined?") are answered exactly from the graph. Open-ended questions are answered by the model from retrieved excerpts. Every answer cites lines and says so when the evidence is insufficient. |
| **Search** | ⌘K across files, paths, symbols, code, findings and generated documentation, with language, symbol type, severity, category and functional-area filters. |
| **Reports and downloads** | Every result view has a **Download** menu with PDF, Word (.docx) or Markdown, plus a web page and structured JSON. The main report is **condensed**: it opens with a business **Executive Summary** (headline, key numbers, key points, health and risk, prioritised next steps; in the PDF these are five landscape slides), and the original in-depth text follows as **Summary evidence** with sources. The **Complete Technical Report** scope keeps every finding, file, symbol and map in full. Other scopes: code review, system explanation, architecture, code map, Q&A. A **Brody bundle** (.zip) exports the whole project so it can be reopened later. |

The Markdown report follows a fixed order (Executive Summary → … → Recommendations → **Detailed Code Map** → **Legend**) and folder explanations sit inside Major Functional Areas so the required order never changes; the code map ends with tree, component map, flow map, dependency map, API map, data-model map, test map, integration map, high-risk map, change-impact relationships and legend.

## Export a project and open it again (Brody bundle)

**Export > Brody bundle** (in the Export menu or on the Reports page) downloads one `.zip` with everything: the analysis data behind every view, the source (detected secrets redacted), ready-made reports (PDF, Word, Markdown, HTML), a README and one-click launchers.

To open it:

* **In the interface:** on the home page open **Open a Brody export** and choose the zip, or simply drop it on the ordinary ZIP upload. The project appears with the full interface (review, explain, map, files, ask, export) and is marked *imported*. Nothing is re-analysed, so it works on any Brody, even one with no AI key.
* **One double-click:** unzip it and run `Open in Brody.command` (macOS; the first time, right-click and choose Open), `open-in-brody.sh` (Linux) or `Open in Brody.bat` (Windows, untested). The launcher sends the export to the Brody running at `http://brody:3003` (or `http://localhost:3003`; set `BRODY_URL` for another address) and opens the imported project in your browser.
* **Without Brody:** open `reports/Report.html`, `reports/Report.pdf` or `reports/Report.docx`.

Importing always makes a new project with new ids, so the same file can be imported more than once. Bundles are validated before anything is written, and an invalid or hostile file is refused whole. The API is `GET /api/projects/:id/export?format=bundle` and `POST /api/projects/import-bundle`.

## Look and feel

The interface uses one blue palette family built on deep navy `#1B4965` and cerulean `#006C96`, with Geist for text, Playfair Display for headings and Lora for long-form documentation. The **sun or moon button** in the header opens a brightness control with five levels: Bright, Original, Default, Dark and Darkest. Choose one by dragging the slider, using the arrow keys, or clicking a level name. The choice is remembered and applied before the page paints. A first visit follows your system's dark preference.

Every text and surface pair is checked against WCAG AA at all five levels by `tests/theme.test.ts`, which reads the palette straight from `src/app/globals.css`, and by an axe scan of every page at every level. Diagrams, code highlighting and the PDF, Word and HTML reports use the same palette.

## Configuration

All configuration is environment variables; see [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `AI_PROVIDER` | `auto` (default: Anthropic if its key is set, otherwise OpenAI), `anthropic`, `openai-compatible`, `none`. Overridden by the AI settings panel |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic access; default model `claude-opus-5` |
| `ANTHROPIC_WORKSPACE_ID` | Needed if your key is not scoped to one workspace (the API otherwise returns *"This API key is not scoped to a workspace"*) |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | OpenAI, or any compatible chat endpoint (Azure OpenAI v1, vLLM, Ollama, gateways); default model `gpt-4.1`. A local endpoint needs no key |
| `AI_MODEL` | Legacy single model setting; applies only to the provider the environment selects |
| `AI_EMBEDDING_MODEL` | Enables semantic retrieval through an OpenAI-compatible embeddings endpoint |
| `AI_CONCURRENCY`, `AI_MAX_FILES_REVIEWED`, … | Bounded concurrency and token budgeting |
| `GITHUB_TOKEN` | Optional server-wide token; users can also paste a token per import |
| `CREDENTIAL_SECRET` | Encrypts stored per-project GitHub tokens across restarts (otherwise they live only for the process) |
| `DATABASE_PATH`, `MAX_*` | Storage location and hard limits on files, bytes, ZIP entries and compression ratio. `MAX_UPLOAD_BYTES` (200 MB by default) is also the size Next.js buffers per request; larger uploads are refused with a clear message |
| `AI_MAX_MODULES_EXPLAINED` | How many folders get an AI-written explanation of how their files work together (default 24; the rest are explained from the dependency graph) |
| `STATIC_ANALYSIS`, `RUFF_PATH`, `PYTHON_PATH` | Language analyzer controls |
| `EMBEDDED_WORKER` | `off` to run the worker separately with `npm run worker` |

### Using Claude or OpenAI, and choosing models

Brody works with either API. Click the AI chip at the top right of the home page to open **AI settings**:

* **Provider:** Automatic, Anthropic (Claude), OpenAI or compatible, or Off. Each shows whether its key is present. Keys are read from `.env` only and are never displayed, returned by the API or stored by the panel.
* **Model:** a menu per provider, filled from the provider's own model list. **Refresh models** re-fetches it (Anthropic `GET /v1/models`, OpenAI `GET /models`). Models that cannot do structured output are shown but disabled, and non-chat OpenAI models (embeddings, audio, image, Responses-only) are hidden. If a list cannot be fetched you get built-in suggestions and the reason, and you can always choose **Other model ID…** and type one.
* **Save and test** applies the choice immediately, with no restart, and makes one small request to confirm the key, endpoint and model work. The choice is saved in `data/ai-settings.json` (owner-only) and is shared with the background worker. **Reset to defaults** returns to `.env`.

The same is available over HTTP: `GET /api/ai/settings`, `PUT /api/ai/settings[?test=1]` and `GET /api/ai/models?provider=anthropic|openai-compatible[&refresh=1]`.

OpenAI-compatible endpoints differ, so the provider adapts and remembers: `max_completion_tokens` for OpenAI and `max_tokens` elsewhere (switching if the endpoint rejects one), `json_schema` structured output falling back to `json_object` and then prompt-only JSON, retries with backoff on rate limits and server errors, and a larger budget when a reasoning model runs out of tokens.

Without an AI provider Brody still runs every deterministic stage. The report says so plainly and the AI stages show as *skipped*. If a provider is configured but failing, the home page shows a key problem and the analysis stages show a warning with a fix, rather than reporting success.

## How it works

**Deterministic first.** Files are classified (source, test, config, docs, schema, CI, infra, manifest, generated, vendor, binary), hashed and language-detected. Tree-sitter grammars (TypeScript/TSX, JavaScript, Python, Go, Java, C#, Ruby, Rust, PHP, CSS, HTML, JSON, Shell) produce symbols, imports, calls and inheritance; SQL, Prisma, GraphQL, Markdown and YAML have purpose-built parsers; other languages fall back to text inspection and are marked as such (`text-parsed`), never as AST. Imports are resolved to files (including tsconfig path aliases), calls are resolved to symbols with a confidence score, and ORM/query calls become `READS_FROM`/`WRITES_TO` edges. Routes, models, entry points, external services, environment variables, tests and infrastructure are detected from those facts, and importance is a PageRank over the graph.

**Review is layered and honest about origin.**
1. Static: built-in pattern rules, TypeScript syntax diagnostics, ESLint with a fixed embedded rule set, Python `ast` and Ruff (`--isolated`), `gofmt -e`, plus structural checks (size, complexity, tests, secrets, auth consistency, operations).
2. AI: five focused passes (security; reliability and correctness; performance and data; architecture and API; testing and operations), each over retrieved excerpts plus graph facts (callers, callees, routes, packages).
3. Verification: an AI finding survives only if its file exists, its quoted evidence is found in that file (line numbers are re-anchored to where the quote really is), its patch applies cleanly, and a second sceptical AI pass does not reject it. Otherwise it is dropped or marked **Needs verification**. Static findings are labelled *Static analyzer*, AI findings *AI-inferred*.

**Documentation is built bottom-up:** symbol → file → functional area → architecture → executive summary. A deterministic baseline is generated from the graph for everything; AI enriches it with narrative. Statements whose evidence does not resolve to real lines are dropped. Contradictions between summaries are detected, re-checked against retrieved source and recorded with their resolution; generated data-access claims are cross-checked against the graph.

**Incremental analysis.** Parses are cached by content hash and AI explanations by file hash plus the hashes of the file's dependencies, so re-analysing a changed repository re-processes only what changed ("18 changed, 242 unchanged, 3 removed, 5 added").

## Security model

Imported code is **untrusted data** and is never executed.

* ZIPs are read in memory: entry-count, per-file, total-size and compression-ratio limits; `..`, absolute and drive paths rejected; symlinks skipped. Local folder reads never follow symlinks.
* Nothing from a repository runs. Analyzers only parse: TypeScript syntax check, ESLint with an embedded config (repository ESLint configs are JavaScript and are ignored), Python `ast` in isolated mode, Ruff `--isolated`, `gofmt -e`. `mypy` and `go vet` are deliberately **not** run outside a sandbox because they load plugins or resolve modules; the report lists them as skipped. Subprocesses use no shell, a minimal environment and a timeout.
* Prompt injection: every repository-derived string sent to a model sits inside `<untrusted_repository_content>` tags, embedded copies of that delimiter are neutralised, and the system prompt tells the model to treat the block as data. A test proves injected text stays inside the block.
* Secrets are detected before model use and replaced with `[REDACTED_SECRET]`; findings show masked previews and never store the value. GitHub tokens are only ever sent as an `Authorization` header, encrypted at rest with AES-256-GCM, scrubbed from logs and errors, and never returned by the API.
* Exports escape all repository-derived content.

**There is no user authentication.** Brody is a single-tenant tool. Anyone who can reach the port can read every project and can submit a GitHub token. Run it locally or behind an authenticating reverse proxy, not on the open internet.

## Project layout

```
src/lib/ingest      upload/ZIP/GitHub ingestion, classification, secrets, credentials
src/lib/parse       tree-sitter extractors and text fallbacks
src/lib/graph       import resolution, symbol/call/data-access graph, importance
src/lib/discover    architecture: routes, models, services, env, tests, areas, flows
src/lib/analysis    pattern rules, analyzer adapters, structural checks
src/lib/review      AI review passes, verification, patch validation, dedupe
src/lib/docs        hierarchical documentation, conflict detection, caches
src/lib/retrieval   BM25 + graph + importance (+ optional embeddings) retrieval
src/lib/map         tree, graphs, change impact, diagrams, shared legend
src/lib/ask         repository Q&A
src/lib/export      Markdown / HTML / JSON
src/lib/jobs        persisted job pipeline, worker, cancellation, recovery
src/lib/ai          provider abstraction (Anthropic, OpenAI-compatible), prompts
src/app             Next.js UI and API routes
fixtures/sample-shop  the demonstration repository
drizzle/            SQL migrations
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for design decisions and extension points.

## Testing

```bash
npm test            # 239 unit and integration tests (ingestion, security, parsing, graph, review, docs, API, exports, precision, Claude and OpenAI provider compatibility, theme contrast, folder-level explanations, very large repositories, data model relationships, executive brief, Brody bundle round trips)
npm run typecheck
npm run lint
npm run test:e2e    # builds, then Playwright: full workflow and downloads, 4 viewports x 2 brightness levels, axe accessibility on all 5 levels, brightness control, keyboard, performance budgets
                    # (uses installed Google Chrome; set PW_CHANNEL= to use bundled Chromium)
```

The integration tests analyse `fixtures/sample-shop` end to end (no fixture-specific logic exists in the product) and assert that files, symbols, dependencies, architecture, an API route, a data flow, tests and review findings are discovered. AI behaviour is tested with a scripted provider that returns grounded, fabricated and malformed responses.

## Validation

A full validation of this repository (syntax, correctness, performance, styling, accessibility, downloads, Docker) is in [`docs/validation/VALIDATION_REPORT.pdf`](docs/validation/VALIDATION_REPORT.pdf) (also `.docx` and `.md`). It includes Brody's analysis of its own code in [`docs/validation/self-analysis/`](docs/validation/self-analysis). Headline numbers: 3,000 source files analyse in about 12 seconds under 1 GB; every page loads in under 100 ms with 145 to 237 KB of JavaScript; axe finds no serious or critical accessibility violations at any of the five brightness levels.

## Known limitations

* **Live AI calls were not verified against the real provider in development.** The supplied Anthropic key was rejected with *"not scoped to a workspace"*, so the Anthropic request path is verified only against a faked SDK client, and the OpenAI-compatible path only against a mock HTTP server. The live Anthropic model list request did reach the real API and returned that same workspace error, which the AI settings panel reports with the fix; the success path of model listing is verified against fakes only. No OpenAI key was available, so nothing was run against api.openai.com. Set `ANTHROPIC_WORKSPACE_ID` (or use a workspace-scoped key) and run `npm run verify:ai` to check your provider.
* Private-repository import is verified with a mocked GitHub API (token header, error handling); public import was run live.
* Call and data-flow graphs come from static, name-based resolution. Dynamic dispatch, reflection, dependency injection containers and runtime-registered routes are not visible; edges carry confidence scores and the UI says when nothing is known.
* Languages without a tree-sitter grammar here (Kotlin, Swift, Scala, C/C++, Dart, …) use text inspection: symbols and imports are approximate.
* Route and model detection cover Express-style, Fastify, Hono, NestJS, tRPC, Next.js, SvelteKit, Flask, FastAPI, Django/DRF, Go routers, Spring, ASP.NET, Rails, Laravel/Symfony, Actix/Axum/Rocket and the ORMs listed in `src/lib/discover/catalog.ts`. Others appear as ordinary symbols.
* Storage is SQLite with in-process retrieval and optional JSON-stored embeddings, chosen for a one-command install. It suits repositories up to tens of thousands of files; a Postgres/pgvector backend would be the next step for multi-tenant use.
* The UI was exercised in desktop Chrome; it has semantic markup and labels but has not had a formal accessibility audit.
