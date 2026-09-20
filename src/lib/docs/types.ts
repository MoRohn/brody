/** A single claim with the repository evidence that supports it. */
export interface Statement {
  text: string;
  /** Evidence locations such as "src/a.ts:10-42". */
  evidence: string[];
  origin: "deterministic" | "ai";
}

export interface SymbolDoc {
  symbolId: string;
  name: string;
  signature: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  purpose: string;
  inputs: string;
  process: string;
  outputs: string;
  dependencies: string[];
  usedBy: string[];
  businessMeaning: string;
  importantBehavior: string;
  evidence: string[];
  origin: "deterministic" | "ai";
}

export interface FileDoc {
  path: string;
  role: string;
  area: string;
  purpose: string;
  responsibilities: string[];
  keySymbols: string[];
  howItOperates: string;
  calledBy: string[];
  dependsOn: string[];
  dataIn: string;
  dataOut: string;
  engineeringNotes: string[];
  evidence: string[];
  origin: "deterministic" | "ai";
}

export interface AreaDoc {
  id: string;
  name: string;
  purpose: string;
  businessFunction: string;
  components: { name: string; kind: string; path: string; line: number }[];
  files: string[];
  inputs: string;
  processing: string;
  outputs: string;
  dependencies: string[];
  failureModes: string[];
  relationships: string;
  evidence: string[];
  origin: "deterministic" | "ai";
}

/** One file inside a collection, with its own one-line explanation, so the collection view can link down to the file level. */
export interface CollectionFile { path: string; role: string; purpose: string; lines: number }

/**
 * A collection of files explained as a unit: a folder or module, or any group of files a reader selects.
 * This is the macro level between a single file (FileDoc) and the whole system. It says how the files work TOGETHER
 * (who orchestrates, who is shared, what the outside world can call), not what each file does on its own.
 */
export interface ModuleDoc {
  id: string;
  kind: "folder" | "selection";
  /** Folder path such as "src/services", or "" for a custom selection. */
  path: string;
  name: string;
  title: string;
  depth: number;
  parent: string | null;
  children: string[];
  areas: string[];
  files: CollectionFile[];
  fileCount: number;
  lines: number;
  roles: { role: string; count: number }[];
  purpose: string;
  howFilesWork: string;
  keyFiles: { path: string; why: string }[];
  /** Exported symbols that code outside the collection uses: the collection's real interface. */
  publicSurface: { name: string; kind: string; path: string; line: number; usedBy: number }[];
  internalLinks: { from: string; to: string }[];
  dependsOn: string[];
  usedBy: string[];
  externalPackages: string[];
  dataIn: string;
  dataOut: string;
  findings: { total: number; bySeverity: Record<string, number>; top: string[] };
  tests: string[];
  evidence: string[];
  origin: "deterministic" | "ai";
}

export interface FlowDoc {
  id: string;
  name: string;
  trigger: string;
  steps: { label: string; kind: string; path?: string; line?: number; detail?: string }[];
  narrative: string;
  models: string[];
  externals: string[];
  evidence: string[];
  origin: "deterministic" | "ai";
}

export interface ConflictRecord {
  subject: string;
  claims: string[];
  resolution: string;
  preferred: "source-evidence" | "graph" | "unresolved";
  evidence: string[];
}

/**
 * The business-readable summary that opens the report and the Explain page: short, plain-language, deck-shaped.
 * The in-depth statements it is distilled from stay available as DocReport.executiveSummary, shown as "Summary evidence".
 */
export interface ExecutiveBrief {
  headline: string;
  summary: string;
  audience: string;
  /** Four to six one-slide messages: title plus one or two sentences. */
  keyPoints: { title: string; detail: string }[];
  /** Business capabilities, one line each. */
  capabilities: string[];
  health: { verdict: string; strengths: string[]; concerns: string[] };
  nextSteps: { action: string; why: string; priority: "Now" | "Next" | "Later" }[];
  /** Headline numbers, always computed from the repository, never written by a model. */
  metrics: { label: string; value: string }[];
  origin: "deterministic" | "ai";
}

export interface DocSection {
  title: string;
  paragraphs: Statement[];
  bullets?: Statement[];
}

export interface DocReport {
  title: string;
  generatedAt: number;
  /** The in-depth, evidence-linked summary. Presented as "Summary evidence" beneath the brief. */
  executiveSummary: Statement[];
  /** The business-readable Executive Summary. Absent in reports generated before it existed; derive it with buildBrief. */
  brief?: ExecutiveBrief;
  atAGlance: { area: string; description: string; evidence?: string[] }[];
  architectureOverview: DocSection;
  runtimeFlow: { narrative: Statement[]; steps: { label: string; detail: string; evidence: string[] }[] };
  areas: AreaDoc[];
  /** Folder-level explanations. Absent in reports generated before this level existed. */
  modules?: ModuleDoc[];
  flows: FlowDoc[];
  apiArchitecture: DocSection;
  dataArchitecture: DocSection;
  integrations: { name: string; category: string; where: string[]; why: string; ifUnavailable: string }[];
  infrastructure: DocSection;
  testing: DocSection;
  securityModel: DocSection;
  risks: DocSection;
  recommendations: Statement[];
  files: FileDoc[];
  symbols: SymbolDoc[];
  conflicts: ConflictRecord[];
  meta: { aiUsed: boolean; model?: string; provider?: string; deterministicSections: number; aiSections: number; droppedUngrounded: number; notes: string[] };
}
