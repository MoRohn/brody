/**
 * What may leave the machine. Narration is built from repository content, so before any text goes to a cloud voice Brody
 * decides how sensitive it is and applies the configured policy:
 *
 *   local-only  never send narration out; cloud voices are not offered
 *   ask         (default) send only when the request explicitly allows it for this job
 *   allow       repository narration may go to a configured cloud voice; secrets never do
 *
 * Detected secrets are redacted from narration in every case and make the text ineligible for any external provider.
 */
import { detectSecrets, redactSecrets } from "../ingest/secrets";
import type { ProjectRow } from "../db/schema";

export type Sensitivity = "public" | "confidential" | "secret";

export interface PrivacyDecision {
  sensitivity: Sensitivity;
  reasons: string[];
  externalAllowed: boolean;
  /** Why external providers are blocked, when they are. */
  blockedBecause?: string;
}

export function classifyNarration(text: string, project: Pick<ProjectRow, "sourceType" | "sourceUrl"> | null): { sensitivity: Sensitivity; reasons: string[] } {
  const secrets = detectSecrets(text);
  if (secrets.length) return { sensitivity: "secret", reasons: [`narration contains ${secrets.length} value(s) that look like secrets (${[...new Set(secrets.map((s) => s.kind))].join(", ")})`] };
  if (!project) return { sensitivity: "confidential", reasons: ["the source project is unknown"] };
  // A GitHub import made without a token can only be a public repository; everything else (uploads, private imports) is the user's own code.
  const publicRepo = project.sourceType === "github" && !!project.sourceUrl;
  if (publicRepo) return { sensitivity: "public", reasons: ["narration describes a GitHub repository"] };
  return { sensitivity: "confidential", reasons: [`narration describes code uploaded from a ${project.sourceType}, which may be private`] };
}

export function decideExternal(sensitivity: Sensitivity, policy: "local-only" | "ask" | "allow", allowExternal: boolean | undefined, privateRepoToken: boolean): PrivacyDecision {
  const reasons: string[] = [];
  if (sensitivity === "secret") return { sensitivity, reasons, externalAllowed: false, blockedBecause: "the narration contains secret-like values, which are never sent to an external service" };
  if (policy === "local-only") return { sensitivity, reasons, externalAllowed: false, blockedBecause: "the privacy policy is local-only" };
  if (privateRepoToken && policy !== "allow" && !allowExternal) return { sensitivity: "confidential", reasons, externalAllowed: false, blockedBecause: "the repository was imported with a private access token" };
  if (policy === "ask" && !allowExternal) return { sensitivity, reasons, externalAllowed: false, blockedBecause: "sending narration to a cloud voice needs your explicit permission for this video (privacy policy: ask)" };
  return { sensitivity, reasons, externalAllowed: true };
}

/** Narration with secret-looking values removed. Applied before synthesis whatever the provider. */
export function sanitizeNarration(text: string): string {
  return redactSecrets(text).replace(/\[REDACTED_SECRET\]/g, "a redacted value");
}
