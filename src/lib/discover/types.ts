export interface Evidence {
  path: string;
  line?: number;
  endLine?: number;
}

export interface EntryPoint {
  path: string;
  kind: "application" | "cli" | "web-server" | "worker" | "scheduled" | "frontend" | "container" | "script" | "test-runner" | "library";
  reason: string;
  symbolId?: string;
  symbolName?: string;
  line?: number;
}

export interface RouteInfo {
  method: string;
  path: string;
  handler: string;
  file: string;
  line: number;
  framework: string;
  auth: "public" | "authenticated" | "unknown";
  symbolId?: string;
  kind: "api" | "page" | "websocket" | "graphql";
}

export interface ModelField { name: string; type: string; /** True when this field points at another model. */ relation?: boolean }

export interface ModelRelation {
  /** The other model's unique id. */
  target: string;
  targetName: string;
  /** The field or foreign key that creates the link. */
  via: string;
  cardinality: "one" | "many" | "optional";
  source: "foreign-key" | "type-reference" | "schema-ref" | "orm-relation";
}

export interface ModelInfo {
  /** Unique id: two models can share a name in different files. */
  id?: string;
  name: string;
  file: string;
  line: number;
  endLine: number;
  kind: string;
  fields: string[];
  /** Field names with their declared types, when the language exposes them. */
  fieldTypes?: ModelField[];
  /** Names of models this one points at (kept for compatibility; see relations). */
  references: string[];
  relations?: ModelRelation[];
  symbolId: string;
  orm?: string;
}

export interface ExternalService {
  name: string;
  category: string;
  evidence: Evidence[];
  via: string[];
  purpose: string;
  failureImpact: string;
}

export interface DependencyInfo {
  name: string;
  version?: string;
  manifest: string;
  dev: boolean;
  ecosystem: string;
  usedBy: number;
}

export interface EnvVar {
  name: string;
  files: Evidence[];
  declaredIn: string[];
  sensitive: boolean;
}

export interface FunctionalArea {
  id: string;
  name: string;
  description: string;
  role: string;
  files: string[];
  keySymbols: { name: string; kind: string; path: string; line: number; id: string }[];
  dependsOn: string[];
  usedBy: string[];
  externalServices: string[];
  models: string[];
  routes: string[];
  tests: string[];
  findingsCount?: number;
}

export interface FlowStep {
  label: string;
  kind: string;
  path?: string;
  line?: number;
  symbolId?: string;
  detail?: string;
}

export interface DataFlow {
  id: string;
  name: string;
  kind: "request" | "job" | "event" | "startup" | "pipeline";
  trigger: string;
  steps: FlowStep[];
  models: string[];
  externals: string[];
  evidence: Evidence[];
}

export interface TestInfo {
  path: string;
  kind: "unit" | "integration" | "e2e" | "fixture" | "mock" | "helper";
  framework?: string;
  targets: string[];
}

export interface InfraInfo {
  path: string;
  kind: string;
  detail: string;
}

export interface AIComponent {
  path: string;
  line?: number;
  kind: "provider" | "prompt" | "embedding" | "vector-store" | "agent" | "tool" | "orchestration";
  detail: string;
}

export interface TechStack {
  languages: { name: string; bytes: number; files: number }[];
  frameworks: { name: string; category: string; evidence: string }[];
  databases: string[];
  infrastructure: string[];
  testing: string[];
}

export interface Architecture {
  pattern: { label: string; confidence: "high" | "medium" | "low"; reasoning: string[] };
  applicationType: string;
  entryPoints: EntryPoint[];
  routes: RouteInfo[];
  models: ModelInfo[];
  externalServices: ExternalService[];
  dependencies: DependencyInfo[];
  envVars: EnvVar[];
  ports: { value: string; path: string; line?: number }[];
  featureFlags: { name: string; path: string; line?: number }[];
  configFiles: string[];
  infra: InfraInfo[];
  areas: FunctionalArea[];
  roles: Record<string, string>;
  flows: DataFlow[];
  tests: { files: TestInfo[]; frameworks: string[]; untestedCritical: { path: string; reason: string }[]; coverageByArea: Record<string, { tested: number; total: number }> };
  ai: AIComponent[];
  stack: TechStack;
  layers: { name: string; files: number; description: string }[];
  stats: Record<string, number>;
  secrets: { path: string; line: number; kind: string; preview: string }[];
  excludedSummary: Record<string, number>;
}
