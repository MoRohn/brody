import { eq } from "drizzle-orm";
import { getDb, projectRows, schema } from "../db/client";
import type { Architecture } from "../discover/types";
import { loadProjectFiles } from "../graph/build";
import type { FindingDraft } from "../review/types";
import { detectControls, type ScanFile } from "./controls";
import { privacyFindings } from "./findings";
import { piiInventory } from "./inventory";
import { buildPrivacyAssessment } from "./privacy";
import { buildSecurityAssessment } from "./security";
import type { Assurance, Control, PiiField } from "./types";

export type * from "./types";
export { classifyFinding, OWASP } from "./taxonomy";
export { classifyField, detectPiiValues, PII_CATEGORIES, SENSITIVITY_LABEL } from "./pii";

export interface AssuranceScan { controls: Control[]; inventory: PiiField[]; drafts: FindingDraft[] }

/** The deterministic part of the assessments that runs with static analysis: controls, the PII inventory and privacy findings. */
export function scanAssurance(files: ScanFile[], arch: Architecture): AssuranceScan {
  const textOf = new Map(files.map((f) => [f.path, f.text]));
  const controls = detectControls(files, arch);
  const inventory = piiInventory(arch, (p) => textOf.get(p));
  // Password hashing only matters where passwords exist: a password field, or a sign-in or registration route.
  const pw = controls.find((c) => c.key === "password-hashing");
  if (pw?.status === "missing" && !inventory.some((f) => f.category === "credential" && /pass/i.test(f.field)) && !arch.routes.some((r) => /(login|signin|sign-in|signup|sign-up|register|password)/i.test(r.path))) {
    pw.status = "na";
    pw.detail = "No password field or sign-in route was found, so passwords do not appear to be handled here.";
  }
  return { controls, inventory, drafts: privacyFindings(files, arch, inventory, controls) };
}

type PipelineInfo = { analyzers?: { name: string; status: string }[]; ai?: { ran: boolean; reviewedFiles?: number } } | null | undefined;

/** Build both assessments from the persisted findings, so they agree with the Code Review exactly. */
export function buildAssurance(projectId: string, arch: Architecture, opts: { scan?: AssuranceScan; pipeline?: PipelineInfo; formal?: { status?: string } | null } = {}): Assurance {
  const scan = opts.scan ?? scanAssurance(loadProjectFiles(projectId).filter((f) => !f.isExcluded), arch);
  const findings = projectRows(schema.findings, projectId);
  return {
    generatedAt: Date.now(),
    security: buildSecurityAssessment({ arch, findings, controls: scan.controls, pipeline: opts.pipeline, formal: opts.formal }),
    privacy: buildPrivacyAssessment({ arch, findings, controls: scan.controls, inventory: scan.inventory }),
  };
}

export function saveAssurance(projectId: string, assurance: Assurance): void {
  const db = getDb();
  const cur = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (cur) db.update(schema.projects).set({ analysis: { ...(cur.analysis ?? {}), assurance } }).where(eq(schema.projects.id, projectId)).run();
}

const memo = new Map<string, { at: number; value: Assurance }>();

/** The stored assessments, or (for analyses made before they existed, and imported bundles) assessments built on demand. */
export function loadAssurance(projectId: string): Assurance {
  const project = getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
  if (!project) throw new Error("Project not found");
  const analysis = (project.analysis ?? {}) as { assurance?: Assurance; architecture?: Architecture; pipeline?: PipelineInfo; formal?: { status?: string } };
  if (analysis.assurance?.security && analysis.assurance?.privacy) return analysis.assurance;
  if (!analysis.architecture) throw new Error("The analysis has not finished, so there is no assessment yet.");
  const hit = memo.get(projectId);
  if (hit && hit.at === project.updatedAt) return hit.value;
  const value = buildAssurance(projectId, analysis.architecture, { pipeline: analysis.pipeline, formal: analysis.formal });
  memo.set(projectId, { at: project.updatedAt, value });
  if (memo.size > 20) memo.delete(memo.keys().next().value!);
  return value;
}
