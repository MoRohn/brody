/** What a formal property is meant to show: that the code keeps a promise, or that it breaks one on a concrete input. */
export type PropertyIntent = "holds" | "violated";

/**
 * What a checked property means for the review:
 * - defect: a counterexample was proved and the audit found the model faithful, so the code really misbehaves on that input;
 * - guarantee: the property was proved for every input the callers can pass;
 * - confirms-claim / refutes-claim: the same, for a claim made by the AI review, which is then verified or removed;
 * - disputed: Lean accepted the proof, but the audit found the model or the statement does not match the code;
 * - unproven: Lean did not accept a proof within the repair budget (this says nothing either way);
 * - refused: the model's Lean used a forbidden construct.
 */
export type PropertyOutcome = "defect" | "guarantee" | "confirms-claim" | "refutes-claim" | "disputed" | "unproven" | "refused";

export interface FormalProperty {
  theorem: string;
  intent: PropertyIntent;
  /** The property in plain words (for a violation: what goes wrong). */
  claim: string;
  /** Short finding title for a violation. */
  title: string;
  /** Index into the target's claims when the property settles a claim from the AI review. */
  claimIndex: number | null;
  startLine: number;
  endLine: number;
  /** For a violation: the concrete input and the wrong result, in plain words. */
  witness: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  category: "Correctness" | "Reliability" | "Security" | "Data";
  whyItMatters: string;
  remediation: string;
  /** The Lean theorem as checked. */
  lean: string;
  proved: boolean;
  axioms: string[];
  /** Lean's errors from the last round, when not proved. */
  errors: string[];
  audit?: { statementMatchesClaim: boolean; hypothesesRealistic: boolean; witnessOnSource: "reproduces" | "does_not_reproduce" | "not_applicable"; note: string };
  outcome: PropertyOutcome;
  findingCode?: string;
}

export interface FormalClaim {
  title: string;
  claim: string;
  startLine: number;
  endLine: number;
}

export interface FormalTarget {
  id: string;
  filePath: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  language: string;
  complexity: number;
  /** Why this function was chosen. */
  reasons: string[];
  claims: FormalClaim[];
  status: "checked" | "not-modelable" | "failed";
  note: string;
  /** Simplifications made when modelling the code (number types, IO taken as inputs...). */
  assumptions: string[];
  /** Divergences between the Lean model and the source found by the audit. */
  divergences: string[];
  modelFaithful: boolean | null;
  /** The Lean file that was checked (model and theorems). */
  lean: string;
  rounds: number;
  ms: number;
  cached: boolean;
  properties: FormalProperty[];
}

export interface FormalReport {
  status: "ran" | "skipped";
  reason?: string;
  lean?: string;
  model?: string;
  generatedAt: number;
  targets: FormalTarget[];
  totals: { targets: number; checked: number; proved: number; defects: number; guarantees: number; claimsConfirmed: number; claimsRefuted: number; disputed: number; unproven: number };
}
