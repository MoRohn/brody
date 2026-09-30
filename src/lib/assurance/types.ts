import type { PiiSensitivity, Protection } from "./pii";

export interface Loc { path: string; line?: number }

/** A security or privacy control, detected from dependencies, configuration and code (never by running anything). */
export interface Control {
  key: string;
  name: string;
  domain: "security" | "privacy";
  /** present: evidence found; partial: some evidence, with gaps; missing: looked for and not found; gap: findings show it is broken; na: does not apply. */
  status: "present" | "partial" | "missing" | "gap" | "na";
  detail: string;
  evidence: Loc[];
  /** Finding codes that show a weakness in this control. */
  findings?: string[];
}

export interface PiiField {
  model: string;
  field: string;
  category: string;
  categoryLabel: string;
  sensitivity: PiiSensitivity;
  protection: Protection;
  path: string;
  line: number;
}

export interface Recipient {
  name: string;
  category: string;
  /** Why this service is likely to receive personal data. */
  why: string;
  evidence: Loc[];
}

export type Rating = "Critical" | "High" | "Elevated" | "Moderate" | "Low";

export interface FindingRef { code: string; title: string; severity: string; category: string; origin: string; verification: string; location: string; cwe?: string; owasp?: string }

export interface PrivacyAssessment {
  status: "High exposure" | "Needs attention" | "Controls in place" | "Limited personal data" | "No personal data detected";
  rationale: string[];
  fields: PiiField[];
  models: { name: string; path: string; line: number; fields: number; highest: PiiSensitivity; subjects: string }[];
  subjects: string[];
  recipients: Recipient[];
  flows: { name: string; models: string[]; externals: string[] }[];
  controls: Control[];
  findings: FindingRef[];
  regimes: { name: string; why: string }[];
  recommendations: { priority: "Now" | "Next" | "Later"; action: string; why: string }[];
  counts: { fields: number; special: number; high: number; unprotectedSensitive: number; models: number; recipients: number; findings: number; valuesInSource: number };
}

export interface OwaspRow { id: string; name: string; status: "issues" | "clear" | "limited"; findings: FindingRef[]; worst?: string; note: string }

export interface SecurityAssessment {
  rating: Rating;
  rationale: string[];
  counts: { total: number; Critical: number; High: number; Medium: number; Low: number; Informational: number; verified: number; needsVerification: number; formal: number };
  surface: {
    routes: number; apiRoutes: number; authenticated: number; unverifiedApi: number;
    unauthenticatedWrites: { method: string; path: string; location: string }[];
    sensitiveRoutes: { method: string; path: string; location: string; why: string }[];
    entryPoints: number; externalServices: number; sensitiveEnv: string[]; ports: string[]; secrets: number;
  };
  owasp: OwaspRow[];
  controls: Control[];
  findings: FindingRef[];
  plan: { priority: "Now" | "Next" | "Later"; action: string; refs: string[] }[];
  coverage: { staticAnalyzers: string[]; aiReview: boolean; aiFiles: number; formal: boolean; notes: string[] };
}

export interface Assurance {
  generatedAt: number;
  security: SecurityAssessment;
  privacy: PrivacyAssessment;
}
