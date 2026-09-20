// Client-safe report metadata (no server imports), shared by the UI and the exporters.
export type ReportScope = "full" | "complete" | "review" | "explain" | "architecture" | "map" | "ask";

export const SCOPES: Record<ReportScope, { title: string; description: string; slug: string; sections: string[] }> = {
  full: { title: "Repository Intelligence Report", description: "The condensed report: a business summary first, then every section in brief. Start here.", slug: "report", sections: ["exec", "glance", "arch", "runtime", "areas", "flows", "api", "data", "integrations", "infra", "testing", "security", "review", "risks", "files", "symbols", "recs", "codemap", "legend"] },
  complete: { title: "Complete Technical Report", description: "Everything in the report with no trimming: every finding, file, symbol, folder and map in full detail.", slug: "complete-report", sections: ["exec", "glance", "arch", "runtime", "areas", "flows", "api", "data", "integrations", "infra", "testing", "security", "review", "risks", "files", "symbols", "recs", "codemap", "legend"] },
  review: { title: "Code Review Report", description: "Every finding with evidence, impact, remediation and patches, plus analyzers run and risks.", slug: "code-review", sections: ["review", "risks", "recs"] },
  explain: { title: "System Explanation", description: "What the system does and how it works, from executive summary to per-symbol explanations.", slug: "system-explanation", sections: ["exec", "glance", "arch", "runtime", "areas", "flows", "api", "data", "integrations", "infra", "testing", "security", "files", "symbols"] },
  architecture: { title: "Architecture and Code Map", description: "Architecture, APIs, data, integrations, infrastructure and the detailed code map with legend.", slug: "architecture", sections: ["arch", "api", "data", "integrations", "infra", "testing", "codemap", "legend"] },
  map: { title: "Detailed Code Map", description: "Repository tree, component, flow, dependency, API, data, test, integration and risk maps, change impact and legend.", slug: "code-map", sections: ["codemap", "legend"] },
  ask: { title: "Repository Q&A Transcript", description: "Questions asked of this repository and the evidence-backed answers.", slug: "questions", sections: ["qa"] },
};

export function isScope(v: string): v is ReportScope {
  return v in SCOPES;
}

