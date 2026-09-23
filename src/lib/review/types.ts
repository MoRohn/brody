export type Severity = "Critical" | "High" | "Medium" | "Low" | "Informational";
export type Confidence = "High" | "Medium" | "Low";
export type Category = "Correctness" | "Security" | "Reliability" | "Performance" | "Maintainability" | "API Design" | "Data" | "Testing" | "Operations" | "Architecture" | "Dependencies";
export type Verification = "verified" | "needs_verification" | "rejected";

export const CATEGORY_PREFIX: Record<Category, string> = {
  Correctness: "COR", Security: "SEC", Reliability: "REL", Performance: "PERF", Maintainability: "MNT",
  "API Design": "API", Data: "DAT", Testing: "TST", Operations: "OPS", Architecture: "ARC", Dependencies: "DEP",
};

export interface FindingDraft {
  title: string;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  /** static: deterministic analyzers; ai: model judgement checked against the source; formal: proved by the Lean 4 kernel. */
  origin: "static" | "ai" | "formal";
  /** Analyzer name for static findings (eslint, ruff, typescript, brody-rules, lean4...). */
  analyzer?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  evidence?: string;
  whatHappens: string;
  whyItMatters: string;
  businessImpact?: string;
  remediation: string;
  patch?: string;
  relatedComponents?: string[];
  verification?: Verification;
  verificationNote?: string;
  area?: string;
  /** Link to the proof in the formal verification report ("<target id>/<theorem>"); not stored on the finding row. */
  formalRef?: string;
}

export const SEVERITY_ORDER: Severity[] = ["Critical", "High", "Medium", "Low", "Informational"];
