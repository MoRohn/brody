import type { Architecture } from "../discover/types";
import type { FindingDraft } from "../review/types";
import type { ScanFile } from "./controls";
import { detectPiiValues, PERSON_MODEL } from "./pii";
import type { Control, PiiField } from "./types";

const has = (controls: Control[], key: string) => controls.some((c) => c.key === key && (c.status === "present" || c.status === "partial"));
const where = (f: PiiField) => `${f.model}.${f.field} (${f.path}:${f.line})`;

/**
 * Deterministic privacy findings: how personal data is stored, whether it can be deleted, and personal data written
 * into the repository itself. Every finding cites the model field or line it is about.
 */
export function privacyFindings(files: ScanFile[], arch: Architecture, inventory: PiiField[], controls: Control[]): FindingDraft[] {
  const out: FindingDraft[] = [];
  const push = (f: Omit<FindingDraft, "origin" | "verification" | "analyzer">) => out.push({ origin: "static", verification: "verified", analyzer: "brody-privacy", ...f });

  // Passwords kept in clear: a password column that is not a hash, in a codebase with no password-hashing function.
  const plainPw = inventory.filter((f) => f.category === "credential" && f.protection === "none" && /pass(word|wd|code)|^pwd$/i.test(f.field));
  if (plainPw.length && !has(controls, "password-hashing")) {
    const f = plainPw[0];
    push({ title: `Passwords appear to be stored without hashing (${f.model}.${f.field})`, category: "Security", severity: "High", confidence: "Medium", filePath: f.path, startLine: f.line, endLine: f.line,
      evidence: plainPw.slice(0, 5).map(where).join("\n"),
      whatHappens: `The data model stores a password field (${plainPw.map((p) => `${p.model}.${p.field}`).slice(0, 4).join(", ")}) and no password-hashing function (bcrypt, scrypt, Argon2 or PBKDF2) is used anywhere in the code.`,
      whyItMatters: "Anyone who obtains a copy of the database (a backup, a leaked dump, an injection flaw) gets every user's password, and people reuse passwords across services.",
      businessImpact: "A single database leak becomes an account-takeover incident for every customer, with mandatory breach notification.",
      remediation: "Hash passwords with Argon2id, scrypt or bcrypt at registration and on password change, store only the hash, and compare with the library's constant-time verify function. Force a reset for existing accounts.",
      relatedComponents: plainPw.map((p) => `${p.model}.${p.field}`), verificationNote: "Field names from the data model, plus a repository-wide search for password-hashing functions. Hashing done in a separate service would not be visible." });
  }

  // Card security codes must never be stored (PCI DSS requirement 3.3.1); card numbers and national IDs need field-level protection.
  const cvv = inventory.filter((f) => /cvv|cvc|securitycode/i.test(f.field.replace(/[^a-z]/gi, "")));
  if (cvv.length) push({ title: `Card security code stored in the data model (${cvv[0].model}.${cvv[0].field})`, category: "Privacy", severity: "High", confidence: "Medium", filePath: cvv[0].path, startLine: cvv[0].line, endLine: cvv[0].line,
    evidence: cvv.slice(0, 4).map(where).join("\n"),
    whatHappens: "A data model has a field for the card verification code (CVV/CVC).",
    whyItMatters: "PCI DSS forbids storing card verification codes after authorisation, even encrypted. Storing them puts the whole system in scope for a PCI breach.",
    businessImpact: "Fines, loss of the ability to take card payments, and liability for fraud if the data leaks.",
    remediation: "Remove the field and any stored values. Collect card details with the payment provider's hosted fields or tokenisation so they never reach your servers.",
    relatedComponents: cvv.map((f) => `${f.model}.${f.field}`), verificationNote: "Field name in the data model." });

  const sensitive = inventory.filter((f) => f.protection === "none" && (f.category === "government" || f.category === "health" || f.category === "biometric" || (f.category === "financial" && !cvv.includes(f))));
  if (sensitive.length && !has(controls, "encryption")) {
    const byModel = new Map<string, PiiField[]>();
    for (const f of sensitive) byModel.set(`${f.model}@${f.path}`, [...(byModel.get(`${f.model}@${f.path}`) ?? []), f]);
    for (const list of [...byModel.values()].slice(0, 6)) {
      const f = list[0];
      const kinds = [...new Set(list.map((x) => x.categoryLabel.toLowerCase()))].join(" and ");
      const severe = list.some((x) => x.category === "government" || x.category === "financial" || x.sensitivity === "special");
      push({ title: `Sensitive personal data stored without field-level encryption in ${f.model}`, category: "Privacy", severity: severe ? "High" : "Medium", confidence: "Low", filePath: f.path, startLine: f.line, endLine: list[list.length - 1].line,
        evidence: list.slice(0, 6).map(where).join("\n"),
        whatHappens: `${f.model} stores ${kinds} (${list.map((x) => x.field).slice(0, 5).join(", ")}) in ordinary columns, and no application-level encryption or key-management service is used in the code.`,
        whyItMatters: "This data causes the most harm when exposed (identity theft, fraud, discrimination) and is subject to the strictest legal rules. Without field-level encryption it is readable by anyone with database, backup or log access.",
        businessImpact: "A breach would require notifying regulators and every affected person, with significant fines and reputational damage.",
        remediation: "Encrypt these fields in the application with keys held in a KMS or vault (envelope encryption), or tokenise them with a specialist provider, and restrict which roles can decrypt. Consider whether the data needs to be kept at all.",
        relatedComponents: list.map((x) => `${x.model}.${x.field}`), verificationNote: "Field names in the data model and a repository-wide search for encryption code. Transparent database or disk encryption configured in the hosting platform is not visible to this check." });
    }
  }

  // Erasure: a system that stores information about people should be able to delete it.
  const people = inventory.filter((f) => PERSON_MODEL.test(f.model) && ["contact", "name", "government", "financial", "health", "birth", "address"].includes(f.category));
  const apiRoutes = arch.routes.filter((r) => r.kind === "api");
  const deleteRoute = arch.routes.some((r) => r.method === "DELETE" && /(user|account|customer|profile|member|me)\b/i.test(r.path));
  if (people.length && apiRoutes.length >= 3 && !deleteRoute && !has(controls, "erasure")) {
    push({ title: "No way to delete a person's data was found", category: "Privacy", severity: "Low", confidence: "Low", filePath: people[0].path, startLine: people[0].line, endLine: people[0].line,
      evidence: people.slice(0, 5).map(where).join("\n"),
      whatHappens: `The system stores personal data about people (${[...new Set(people.map((p) => p.model))].slice(0, 4).join(", ")}), but no route or function deletes or anonymises an account.`,
      whyItMatters: "GDPR, UK GDPR, CCPA/CPRA and similar laws give people the right to have their data erased. Without a built-in path each request needs manual database work, which is slow and error-prone.",
      remediation: "Add an account-deletion flow that removes or anonymises the person's records (including derived data, backups on a schedule, and data held by processors) and records that the request was fulfilled.",
      relatedComponents: [...new Set(people.map((p) => p.model))], verificationNote: "Searched routes and code for delete, erase, anonymise and forget operations on people; a separate admin tool would not be visible." });
  }

  // Personal data committed to the repository (seed data, fixtures that are not tests, examples).
  const valueHits: { path: string; line: number; kind: string; preview: string }[] = [];
  for (const f of files) {
    if (f.isExcluded || f.isGenerated || f.isTest || !f.text || f.text.length > 2_000_000) continue;
    if (!["source", "config", "schema", "data", "docs"].includes(f.classification) || /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|mocks?|__mocks__)\//i.test(f.path) || /\.(md|mdx|txt|rst)$/i.test(f.path)) continue;
    for (const m of detectPiiValues(f.text)) valueHits.push({ path: f.path, ...m });
  }
  const byFile = new Map<string, typeof valueHits>();
  for (const h of valueHits) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
  for (const [path, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) {
    const kinds = [...new Set(list.map((h) => h.kind))];
    const severe = kinds.some((k) => /Social Security|card/i.test(k));
    push({ title: `Personal data written into ${path}`, category: "Privacy", severity: severe ? "High" : list.length >= 5 ? "Medium" : "Low", confidence: severe ? "Medium" : "Low", filePath: path, startLine: list[0].line, endLine: list[0].line,
      evidence: list.slice(0, 5).map((h) => `line ${h.line}: ${h.kind} ${h.preview}`).join("\n"),
      whatHappens: `The file contains ${list.length} value(s) that look like real personal data (${kinds.join(", ")}). Values are masked in this report.`,
      whyItMatters: "Personal data in a repository is copied to every clone, CI runner and backup, stays in git history after deletion, and is processed without a lawful basis or retention limit.",
      remediation: "Replace the values with synthetic data (for example addresses at example.com and published test card numbers), remove them from git history, and check whether the people concerned need to be notified.",
      verificationNote: "Pattern match: consumer e-mail domains, Luhn-valid card numbers (published test numbers excluded) and Social Security numbers next to an SSN label." });
  }
  return out;
}
