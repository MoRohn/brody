import { sqliteTable, text, integer, real, index, primaryKey } from "drizzle-orm/sqlite-core";

/** Projects: one row per ingested codebase (a repository or an upload). */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sourceType: text("source_type").notNull(), // file | files | folder | zip | github
  sourceUrl: text("source_url"),
  owner: text("owner"),
  branch: text("branch"),
  commit: text("commit"),
  sourceHash: text("source_hash").notNull(),
  fileCount: integer("file_count").notNull().default(0),
  sourceFileCount: integer("source_file_count").notNull().default(0),
  totalBytes: integer("total_bytes").notNull().default(0),
  lineCount: integer("line_count").notNull().default(0),
  languages: text("languages", { mode: "json" }).$type<Record<string, number>>().notNull().default({}),
  status: text("status").notNull().default("created"), // created | analyzing | ready | failed
  /** Serialized analysis outputs that are not row-oriented (architecture, docs, maps). */
  analysis: text("analysis", { mode: "json" }).$type<Record<string, unknown>>(),
  /** Incremental analysis statistics from the most recent run. */
  incremental: text("incremental", { mode: "json" }).$type<Record<string, number>>(),
  previousProjectId: text("previous_project_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Encrypted repository credentials, session scoped and never logged. */
export const credentials = sqliteTable("credentials", {
  projectId: text("project_id").primaryKey(),
  encrypted: text("encrypted").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** Content-addressed blob store so identical files across projects share bytes. */
export const blobs = sqliteTable("blobs", {
  hash: text("hash").primaryKey(),
  content: text("content").notNull(),
  size: integer("size").notNull(),
});

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    directory: text("directory").notNull(),
    extension: text("extension").notNull(),
    language: text("language").notNull(),
    size: integer("size").notNull(),
    lines: integer("lines").notNull().default(0),
    hash: text("hash").notNull(),
    /** source | test | config | docs | schema | ci | infra | manifest | generated | vendor | binary | data | asset | other */
    classification: text("classification").notNull(),
    isBinary: integer("is_binary", { mode: "boolean" }).notNull().default(false),
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
    isGenerated: integer("is_generated", { mode: "boolean" }).notNull().default(false),
    isVendor: integer("is_vendor", { mode: "boolean" }).notNull().default(false),
    isExcluded: integer("is_excluded", { mode: "boolean" }).notNull().default(false),
    excludeReason: text("exclude_reason"),
    isLarge: integer("is_large", { mode: "boolean" }).notNull().default(false),
    hasContent: integer("has_content", { mode: "boolean" }).notNull().default(true),
    duplicateOf: text("duplicate_of"),
    imports: text("imports", { mode: "json" }).$type<string[]>().notNull().default([]),
    exports: text("exports", { mode: "json" }).$type<string[]>().notNull().default([]),
    parseStatus: text("parse_status").notNull().default("pending"), // pending | ast | text | skipped | error
    parseError: text("parse_error"),
    module: text("module"),
    /** Functional area assigned during architecture detection. */
    area: text("area"),
    /** Architectural role: entry | ui | api | service | data | ai | infra | test | config | docs | util | unknown */
    role: text("role"),
    importance: real("importance").notNull().default(0),
    /** AI or heuristic explanation payload. */
    explanation: text("explanation", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("files_project_idx").on(t.projectId), index("files_project_path_idx").on(t.projectId, t.path)],
);

export const symbols = sqliteTable(
  "symbols",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    fileId: text("file_id").notNull(),
    filePath: text("file_path").notNull(),
    name: text("name").notNull(),
    qualifiedName: text("qualified_name").notNull(),
    kind: text("kind").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    signature: text("signature"),
    visibility: text("visibility").notNull().default("internal"),
    parentId: text("parent_id"),
    documentation: text("documentation"),
    exported: integer("exported", { mode: "boolean" }).notNull().default(false),
    /** Extra structured metadata (route path, http method, model fields...). */
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    inboundCount: integer("inbound_count").notNull().default(0),
    outboundCount: integer("outbound_count").notNull().default(0),
    importance: real("importance").notNull().default(0),
    explanation: text("explanation", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("symbols_project_idx").on(t.projectId), index("symbols_file_idx").on(t.fileId), index("symbols_name_idx").on(t.projectId, t.name)],
);

/** Directed relationships between symbols or files. */
export const relationships = sqliteTable(
  "relationships",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // IMPORTS | CALLS | EXTENDS | ... | DEPENDS_ON
    sourceType: text("source_type").notNull(), // file | symbol | external
    sourceId: text("source_id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    filePath: text("file_path"),
    line: integer("line"),
    confidence: real("confidence").notNull().default(1),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("rel_project_idx").on(t.projectId), index("rel_source_idx").on(t.sourceId), index("rel_target_idx").on(t.targetId)],
);

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    code: text("code").notNull(), // e.g. REL-004
    title: text("title").notNull(),
    category: text("category").notNull(),
    severity: text("severity").notNull(),
    confidence: text("confidence").notNull(),
    /** static | ai */
    origin: text("origin").notNull(),
    analyzer: text("analyzer"),
    filePath: text("file_path"),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    evidence: text("evidence"),
    whatHappens: text("what_happens").notNull(),
    whyItMatters: text("why_it_matters").notNull(),
    businessImpact: text("business_impact"),
    remediation: text("remediation").notNull(),
    patch: text("patch"),
    relatedComponents: text("related_components", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** verified | needs_verification | rejected */
    verification: text("verification").notNull().default("needs_verification"),
    verificationNote: text("verification_note"),
    area: text("area"),
  },
  (t) => [index("findings_project_idx").on(t.projectId)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    status: text("status").notNull(), // queued | running | succeeded | failed | cancelled
    stages: text("stages", { mode: "json" }).$type<JobStage[]>().notNull().default([]),
    currentStage: text("current_stage"),
    error: text("error"),
    log: text("log", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    heartbeatAt: integer("heartbeat_at"),
    /** Set when the user requests cancellation; the runner checks it between units of work. */
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    /** AI usage and result summary for the run. */
    summary: text("summary", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("jobs_project_idx").on(t.projectId), index("jobs_status_idx").on(t.status)],
);

/** Parse results keyed by content hash so unchanged files are never re-parsed. */
export const parseCache = sqliteTable("parse_cache", {
  key: text("key").primaryKey(), // `${parserVersion}:${language}:${grammar}:${hash}`
  payload: text("payload").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** AI explanation reuse keyed by content hash plus the hashes of direct dependencies. */
export const explainCache = sqliteTable("explain_cache", {
  key: text("key").primaryKey(),
  kind: text("kind").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at").notNull(),
});

/** Lexical + semantic index entries for retrieval. */
export const indexEntries = sqliteTable(
  "index_entries",
  {
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(), // file | symbol | finding | doc
    refId: text("ref_id").notNull(),
    filePath: text("file_path"),
    title: text("title").notNull(),
    terms: text("terms").notNull(),
    text: text("text").notNull(),
    embedding: text("embedding", { mode: "json" }).$type<number[]>(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.kind, t.refId] }), index("index_project_idx").on(t.projectId)],
);

export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    question: text("question").notNull(),
    answer: text("answer", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("questions_project_idx").on(t.projectId)],
);

/**
 * Explanation artifacts: the canonical Explanation IR compiled from one grounded Brody result. Every explanation format
 * (clear prose, diagram, interactive player, video) is rendered from `spec`.
 */
export const explanations = sqliteTable(
  "explanations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    /** The Brody result it explains: question:<id>, file:<path>, area:<id>, module:<path>, finding:<code> or system. */
    sourceRunId: text("source_run_id").notNull(),
    source: text("source", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    title: text("title").notNull(),
    audience: text("audience").notNull(),
    spec: text("spec", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    specHash: text("spec_hash").notNull(),
    /** ExplanationModeRouter output. */
    router: text("router", { mode: "json" }).$type<Record<string, unknown>>(),
    /** How the spec was compiled: model used, items dropped by the grounding guard. */
    compile: text("compile", { mode: "json" }).$type<Record<string, unknown>>(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("explanations_project_idx").on(t.projectId), index("explanations_source_idx").on(t.projectId, t.sourceRunId)],
);

/** Durable explainer video jobs. Stages persist their outputs by content hash, so retry and resume skip finished work. */
export const videoJobs = sqliteTable(
  "video_jobs",
  {
    id: text("id").primaryKey(),
    explanationId: text("explanation_id").notNull(),
    projectId: text("project_id").notNull(),
    /** video | section | narration */
    kind: text("kind").notNull(),
    /** queued | running | ready | failed | cancelled */
    status: text("status").notNull(),
    params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    stages: text("stages", { mode: "json" }).$type<JobStage[]>().notNull().default([]),
    currentStage: text("current_stage"),
    /** Content hashes of each completed stage's inputs. */
    stageHashes: text("stage_hashes", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    /** Live progress of the current stage: fraction 0..1 and a short message. */
    progress: text("progress", { mode: "json" }).$type<Record<string, unknown>>(),
    /** Artifacts available so far (plan, transcript, audio, storyboard, video), as paths relative to the explanation directory. */
    artifacts: text("artifacts", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    manifest: text("manifest", { mode: "json" }).$type<Record<string, unknown>>(),
    validation: text("validation", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error"),
    log: text("log", { mode: "json" }).$type<string[]>().notNull().default([]),
    attempts: integer("attempts").notNull().default(0),
    parentJobId: text("parent_job_id"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    heartbeatAt: integer("heartbeat_at"),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    /** Stage metrics, token usage and cost. */
    summary: text("summary", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("video_jobs_explanation_idx").on(t.explanationId), index("video_jobs_status_idx").on(t.status), index("video_jobs_project_idx").on(t.projectId)],
);

export interface JobStage {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "warning" | "failed" | "skipped";
  startedAt?: number;
  finishedAt?: number;
  detail?: string;
}

export type ProjectRow = typeof projects.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type SymbolRow = typeof symbols.$inferSelect;
export type RelationshipRow = typeof relationships.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type IndexEntryRow = typeof indexEntries.$inferSelect;
export type ExplanationRow = typeof explanations.$inferSelect;
export type VideoJobRow = typeof videoJobs.$inferSelect;
