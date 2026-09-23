# Architecture

## Principle

```
SOURCE CODE → DETERMINISTIC CODE INTELLIGENCE → STRUCTURED REPOSITORY MODEL
            → CONTEXT RETRIEVAL → AI REASONING → EVIDENCE VERIFICATION
            → DOCUMENTATION + REVIEW + MAP
```

The application never turns into `SOURCE CODE → GIANT PROMPT → UNVERIFIED TEXT`. Models receive small, targeted, redacted excerpts plus graph facts, return schema-validated JSON, and anything they claim is checked against the repository before it is persisted or shown.

## Runtime shape

One Next.js process serves the UI and JSON API and hosts an in-process job worker (`src/instrumentation.ts` → `startWorker`). State lives in SQLite (WAL) through Drizzle. Analysis runs as a persisted job, so a page refresh or server restart never loses progress; jobs are claimed atomically, heartbeat while running, and are re-queued if the worker dies. The worker can be split out (`EMBEDDED_WORKER=off`, `npm run worker`) because the database is the queue. Long-running model calls are `await`ed on the worker and never block request handlers; CPU-heavy parsing yields to the event loop.

Choices made to keep the system simple: SQLite instead of Postgres + Redis (one file, no services), tree-sitter WASM instead of native bindings (no compilers at install time), React Flow + dagre for interactive graphs, Mermaid only for exportable diagrams.

## Job pipeline (14 persisted stages)

1. Importing repository (GitHub download happens here so progress and failures persist)
2. Enumerating files (classification counts, incremental diff)
3. Parsing source (tree-sitter / text fallback; cached by content hash)
4. Building symbol and dependency graph
5. Indexing for retrieval
6. Detecting architecture
7. Running static analysis
8. Reviewing code (AI passes)
9. Formally verifying complex code (Lean 4; skipped with the reason when there is no AI provider or no Lean toolchain)
10. Verifying findings
11. Generating documentation
12. Building code map artifacts
13. Building executive deck (a business-level view of the same analysis; failure here only warns, the deck is then built on first request)
14. Finalizing report

Stage status is `done`, `skipped` (with the reason), `warning` (completed but not as intended, e.g. every AI request failed) or `failed`. Cancellation is checked between units of work.

## Data model (`src/lib/db/schema.ts`)

`projects`, `files` (path, language, hash, classification, role, area, parse status), `symbols` (kind, qualified name, line range, signature, docs, importance, metadata), `relationships` (IMPORTS, CALLS, INSTANTIATES, EXTENDS, IMPLEMENTS, USES, READS_FROM, WRITES_TO, ROUTES_TO, EMITS, SUBSCRIBES_TO, TESTS, DEPENDS_ON with confidence), `findings`, `jobs`, `index_entries`, `questions`, `blobs` (content-addressed file bodies), `credentials` (encrypted), and two caches: `parse_cache` (content hash → parse) and `explain_cache` (file hash + dependency hashes → explanation).

## AI usage and cost

Providers call `recordUsage` after every billable response (analysis calls, their retries and embeddings) with the model that actually answered (`msg.model`; a server-side fallback can differ from the requested model) and the provider's own token counts, including Anthropic cache reads and writes and OpenAI cached prompt tokens. The record goes to the `UsageLedger` of the current run, found through `AsyncLocalStorage` (`withUsageLedger` wraps `processJob`), so nothing is threaded through call sites and calls outside a run (health checks, other requests) are never attributed to it. The ledger aggregates by model and by pipeline step (from the task prefix) and prices each model with `priceFor` (`ai/pricing.ts`: `AI_PRICING`, then dated Anthropic and OpenAI list prices; an OpenAI-compatible endpoint other than api.openai.com is never priced as OpenAI). The job saves a snapshot on its `summary` at most once a second while it runs (`live: true`), and the final snapshot as `summary.aiUsage` when it succeeds, fails or is cancelled. `components/usage.tsx` renders it as the header gauge and popover and on the progress screen. When list prices change, update the tables and `PRICES_AS_OF`.

## Retrieval

`search()` scores BM25 over identifier/path terms, adds a graph-neighbour bonus for the strongest symbol hits, an importance prior (PageRank over the graph, entry points, endpoints, models) and, when an embedding model is configured, cosine similarity. `retrieveContext()` turns hits into excerpts with real line ranges for prompts. Raw-code scanning is available as another signal.

## Review verification

`verifyDeterministic` (source of truth) rejects candidates that cite unknown files, re-anchors line numbers to where the quoted evidence occurs, rejects high-severity findings whose quote is fabricated, downgrades findings in tests, adds caller/reachability notes, and validates suggested unified diffs by applying them to the file. `verifyWithAI` then asks a sceptical pass to confirm, reject or mark *needs verification* with the surrounding code and known callers. Deduplication merges restatements of the same problem but never collapses different problems on adjacent lines; it keeps static findings over proofs, and proofs over AI judgement.

## Formal verification (`src/lib/formal`)

Runs between the AI review and the AI verifier, on the candidates that survived `verifyDeterministic`.

* **Targets** (`targets.ts`): functions of 3 to 200 lines in source files, ranked by open AI claims (routed to the smallest enclosing function; Correctness, Reliability, Data and Security), cyclomatic complexity (`meta.complexity`), arithmetic and comparison density, risky names and importance. Each target carries up to three called helpers and the project's test lines that name it. Depth grows with complexity: property count (2-3, 3-5, 4-6) and repair rounds (`1 + complexity/10`, one more with claims, capped by `FORMAL_MAX_REPAIR_ROUNDS`).
* **Model and repair** (`index.ts`): the model writes a pure Lean model and theorems (`FormalPlanSchema`) under rules that pin down language semantics that decide fidelity (division rounding per language, division by zero, fixed-width overflow as `BitVec`, IO results as inputs, no `Float`). Each property is a guarantee (`holds`) or an explicit-witness counterexample (`violated`), and every routed claim must be settled by exactly one. Lean's diagnostics go back verbatim; the round with the most proved theorems is kept as one consistent whole.
* **Checker** (`lean.ts`): `screenLeanSource` refuses code-executing and proof-faking constructs by scanning the raw text, so there is no lexer to disagree with Lean's. `checkLean` assembles the file, runs the toolchain binary with `--json`, `-M` and `maxHeartbeats` under a wall-clock kill, attributes errors to theorems by line, and reads `#print axioms` only from Brody's own trailing lines. Proved means no error in the theorem or the model, and axioms within `propext`, `Classical.choice`, `Quot.sound`.
* **Audit and outcome** (`decideOutcome`): a sceptical pass checks model fidelity, statement/claim agreement, realistic hypotheses, and hand-executes every counterexample on the source. Only a faithful, matching, reproduced result changes the review: `defect` (new `origin: "formal"`, `analyzer: "lean4"` finding), `confirms-claim` (verified, skips the AI verifier), `refutes-claim` (rejected), `guarantee` (reported). Anything else is `disputed` or `unproven` and stays in the report only.
* **Storage:** the report (`FormalReport`, with the checked Lean file per target) is `analysis.formal`, served by `GET /api/projects/:id/formal` and shown on the Formal Proofs page; `findingCode` links proofs and findings. Results are cached in `explain_cache` (kind `formal`) keyed by the function, helper, test and claim text plus the Lean version and model; bump `FORMAL_VERSION` when prompts or rules change.

## Documentation synthesis

`buildSymbolDocs` / `buildFileDocs` / `buildAreaDocs` / `buildFlowDocs` / `buildReport` create a complete deterministic report. `enhanceWithAI` replaces fields level by level (symbols → files → areas → synthesis), validating every citation with `validateEvidence`, dropping ungrounded statements, detecting conflicts, re-retrieving evidence to resolve them, and cross-checking data-access claims against the graph (`crossCheckDataClaims`).

## Extending

* **New language:** add a grammar to `src/lib/parse/treesitter.ts`, an extractor in `extract.ts`, an import resolver case in `graph/resolve.ts`, and extension mapping in `ingest/languages.ts`.
* **New framework or route style:** add detection in `discover/detect.ts` (routes/models/entry points) and signatures in `discover/catalog.ts`.
* **Formal verification:** to trust a new tactic or library, check `#print axioms` on a proof that uses it; add an import to `OPTIONAL_IMPORTS` in `formal/lean.ts` only if it needs no axiom beyond the standard three and adds no way to run code. Never relax `FORBIDDEN` without a test in `tests/formal.test.ts` showing the construct cannot execute code or fake a proof.
* **New static rule:** append to `analysis/rules.ts` (with a test). New analyzer: add an adapter in `analysis/analyzers.ts` that never executes repository code.
* **Explanation levels:** documentation is built bottom-up in `src/lib/docs`: symbols, then files, then **collections of files** (folders in `modules.ts`, functional areas in `deterministic.ts`), then the system synthesis. Each level has its own model (`SymbolDoc`, `FileDoc`, `ModuleDoc`/`AreaDoc`, `DocReport`), its own prompt with an explicit scale instruction (a file prompt may not describe the wider system; a collection prompt may not restate files one by one), and its own tab on the Explain page. The folder level is derived from the import graph, so it exists without an AI provider; `narrateModule` in `ai.ts` then rewrites its narrative from the file summaries. `GET/POST /api/projects/:id/explain` serves any folder or hand-picked group on demand, including projects analysed before this level existed.
* **Executive brief:** `DocReport.brief` (`ExecutiveBrief`) is the business-readable Executive Summary. `docs/brief.ts` builds it deterministically from the analysis (so it exists without AI and supplies every number); a second, sequential AI step (`narrateBrief` in `docs/ai.ts`, after the technical synthesis) rewrites the words from the in-depth statements, which stay in `executiveSummary` and are shown as "Summary evidence". The main report is concise (`buildMarkdown` detail mode); the `complete` scope keeps full detail. In the PDF the brief is drawn as landscape slides (`drawBriefSlides` in `export/pdf.ts`) and its text version is omitted from the body.
* **Data model map:** `discover/detect.ts` records typed fields and relations (foreign keys, type annotations, schema `$ref`s) with cardinality and unique model ids; `map/index.ts` turns them into an ER diagram; `components/data-model.tsx` shows the diagram and a table with both directions of every relationship. Diagram labels must be plain SVG text (`htmlLabels: false`), because the sanitiser removes `foreignObject`.
* **Bundles:** `src/lib/bundle` writes and reads the Brody bundle. Import validates every table with the schema's own column types, gives every row a new id (also inside the JSON blobs), restores file content into the content-addressed store and rebuilds the search index. Bundles are versioned (`BUNDLE_VERSION`); a newer bundle is refused with a clear message.
* **Large inputs:** never spread a repository-sized array into a call (`Math.max(...xs)`, `a.push(...b)`); use `maxOf` and `pushAll` from `src/lib/util/arrays.ts`. Because the app has a proxy, Next.js buffers request bodies, so `experimental.proxyClientMaxBodySize` in `next.config.ts` is raised to the upload limit; the default of 10 MB silently truncates larger uploads.
* **Bulk database access:** pipeline stages read and write whole tables, and Drizzle's per-row overhead (rebuilding SQL, re-inspecting columns) was about a third of analysis CPU. For those paths use `projectRows`, `bulkInsert` and `bulkUpdate` from `db/client.ts`; they prepare one statement per table and reuse Drizzle's own column encoders and decoders, so stored and returned values are identical (`tests/performance.test.ts` proves it). Batch anything per-file (the parse cache uses `getCachedParses` / `putCachedParses`). `getFileContents` keeps recent blobs in a bounded in-memory cache, which is safe because blobs are content-addressed. `npm run benchmark -- 200 1000 3000` prints per-stage timings.
* **Parse worker threads:** `parse/pool.ts` runs `parse/run.ts` (parse, extract, the TypeScript syntax check and ESLint for one file) on up to four worker threads, so analysis parallelises and the web server stays responsive. The worker is bundled to `dist/parse-worker.cjs` by `tools/build-worker.mjs` (part of `npm run build`, and copied into the Docker image, which otherwise ships only `.next` and `node_modules`); in development the pool runs `parse/worker.ts` through `tsx`, and if no worker can start or one fails, the affected files are parsed in-process with the same code. Everything a worker returns is also stored in the parse cache, so a re-analysis reuses the per-file checks too (bump `PARSER_VERSION` when extraction or the check rule set changes). `analysis/checkcore.ts` is the one implementation of those checks. The worker must import nothing from the database or the web framework. `tests/workers.test.ts` proves worker results equal in-process results.
* **Extractors:** the TypeScript/JavaScript extractor asks the parser once for every node type it needs (`nodeScan` in `parse/extract.ts`) instead of re-walking the tree per question; complexity comes from `parse/complexity.ts`, which indexes branches in a single cursor pass. Keep new per-file work out of hot loops over `descendantsOfType`.
* **Executive deck** (`src/lib/deck`): a 14-slide leadership briefing in HTML, PowerPoint and PDF, derived from the SAME stored analysis as the report (its brief, functional areas, findings, architecture and the code map's layers), never from a second analysis. `content.ts` builds a compact business-level snapshot (`analysis.deck`, written by pipeline stage 12); `layout.ts` turns it into slides on a 1280 x 720 canvas made of plain shapes and pre-wrapped text (measured with the report PDF's DejaVu fonts); `html.ts`, `pdf.ts` and `pptx.ts` only draw those shapes, so the three formats look alike and none has layout logic of its own. PowerPoint gets native tables, editable shapes and speaker notes. Every slide names the report section behind it (numbers read from the report's own section list, checked against the generated report by `tests/deck.test.ts`), and the last slide maps every slide to its report section. `lexicon.ts` is the only place technical findings and routes are put into executive language; a test fails if any built-in review rule lacks wording, and another scans every slide for file paths, code and identifiers. The report code is not touched. Add a slide by adding a function to `layoutDeck` and a `refs` entry; keep body text at 12 px or larger and inside its box (the layout tests check both).
* **Theming:** all colours are CSS variables defined once per brightness level in `src/app/globals.css` (`:root[data-level="..."]`). `src/lib/theme.ts` is the pure model and pre-paint script, `src/lib/themeState.ts` the live hook, and `ThemeControl` the UI. Code that cannot use CSS variables (Mermaid, syntax colours) reads the computed palette or `src/lib/syntax.ts` and re-renders on level change. To retune the palette, edit the tokens and run `npm test`: the contrast tests will say which pairs fall below AA.
* **AI provider and model selection:** `src/lib/ai/settings.ts` resolves the provider and per-provider model (saved selection in `ai-settings.json`, then environment, then default), `src/lib/ai/models.ts` lists and caches each provider's models with a built-in fallback, and `ai/index.ts` builds and caches the provider instance. The web server and worker both read the settings file, so a change applies to the next analysis without a restart.
* **New AI provider:** implement `AIProvider` (`src/lib/ai/types.ts`) and select it in `ai/index.ts`. Responses must be validated against the request's Zod schema.
* **Parser changes:** bump `PARSER_VERSION` in `parse/cache.ts` so cached parses are invalidated; bump `PROMPT_VERSION` in `docs/cache.ts` when explanation prompts change.
