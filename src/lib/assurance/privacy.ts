import type { FindingRow } from "../db/schema";
import type { Architecture } from "../discover/types";
import { CHILD_MODEL, HEALTH_MODEL, SENSITIVITY_ORDER } from "./pii";
import { findingRef, firstSentence } from "./security";
import { classifyFinding } from "./taxonomy";
import type { Control, PiiField, PrivacyAssessment, Recipient } from "./types";

/** Lower-case the first letter only, so acronyms (DSAR, CSP) keep their case mid-sentence. */
export const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const SEV = ["Critical", "High", "Medium", "Low", "Informational"];

/** Service categories that receive personal data in the normal course of their work, and why. */
const RECIPIENT_WHY: Record<string, string> = {
  email: "receives recipients' names and e-mail addresses, and message content",
  messaging: "receives phone numbers or user identifiers and message content",
  payments: "receives payment card data, names and billing addresses",
  fintech: "receives financial account and identity data",
  commerce: "receives customer, order and address data",
  analytics: "receives usage events, device identifiers and often IP addresses",
  observability: "error and trace reports routinely capture request data, user identifiers and IP addresses",
  ai: "prompts sent to the model may contain personal data from the application",
  "vector-db": "stores embeddings and text that may be derived from personal data",
  auth: "holds user identities, e-mail addresses and sign-in history",
  "backend-platform": "hosts the database and user accounts",
  cloud: "stores or processes application data",
  storage: "stores uploaded files, which may contain personal data",
  search: "indexes records that may contain personal data",
  maps: "receives addresses or location coordinates",
  crm: "holds customer contact and relationship data",
};

const SUBJECTS: [RegExp, string][] = [
  [/patient/i, "Patients"],
  [/(child|minor|kid|pupil|student)/i, "Children or students"],
  [/(employee|staff|worker|payroll)/i, "Employees"],
  [/(customer|client|buyer|shopper|order)/i, "Customers"],
  [/(lead|contact|subscriber|prospect)/i, "Contacts, leads and subscribers"],
  [/(applicant|candidate)/i, "Job applicants"],
  [/(user|account|member|profile|person|people)/i, "Users (account holders)"],
];

export interface PrivacyInput {
  arch: Architecture;
  findings: FindingRow[];
  controls: Control[];
  inventory: PiiField[];
}

export function buildPrivacyAssessment({ arch, findings, controls, inventory }: PrivacyInput): PrivacyAssessment {
  const live = findings.filter((f) => f.verification !== "rejected");
  const piiModels = new Map<string, { name: string; path: string; line: number; fields: number; highest: (typeof inventory)[number]["sensitivity"]; subjects: string }>();
  for (const f of inventory) {
    const key = `${f.model}@${f.path}`;
    const cur = piiModels.get(key);
    const m = arch.models.find((x) => x.name === f.model && x.file === f.path);
    if (cur) { cur.fields++; if (SENSITIVITY_ORDER.indexOf(f.sensitivity) < SENSITIVITY_ORDER.indexOf(cur.highest)) cur.highest = f.sensitivity; }
    else piiModels.set(key, { name: f.model, path: f.path, line: m?.line ?? f.line, fields: 1, highest: f.sensitivity, subjects: SUBJECTS.find(([re]) => re.test(f.model))?.[1] ?? "People referenced by this record" });
  }
  const subjects = [...new Set([...piiModels.values()].map((m) => m.subjects).filter((s) => s !== "People referenced by this record"))];
  if (!subjects.length && inventory.length) subjects.push("People referenced by the application's records");

  const recipients: Recipient[] = inventory.length ? arch.externalServices.filter((s) => RECIPIENT_WHY[s.category]).map((s) => ({ name: s.name, category: s.category, why: RECIPIENT_WHY[s.category], evidence: s.evidence.slice(0, 3).map((e) => ({ path: e.path, line: e.line })) })) : [];
  const piiModelNames = new Set(inventory.map((f) => f.model));
  const flows = arch.flows.filter((f) => f.models.some((m) => piiModelNames.has(m))).slice(0, 12).map((f) => ({ name: f.name, models: f.models.filter((m) => piiModelNames.has(m)), externals: f.externals }));

  // Findings that affect personal data: every privacy finding, and security flaws that would expose stored records when personal data exists.
  const exposing = new Set(["CWE-89", "CWE-862", "CWE-639", "CWE-22", "CWE-798", "CWE-256", "CWE-311", "CWE-532", "CWE-598", "CWE-319"]);
  const relevant = live.filter((f) => f.category === "Privacy" || f.analyzer === "brody-privacy" || (inventory.length > 0 && f.category === "Security" && ["Critical", "High"].includes(f.severity) && exposing.has(classifyFinding(f).cwe ?? "")))
    .sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || a.code.localeCompare(b.code));
  const refs = relevant.map(findingRef);

  const privacyControls = controls.filter((c) => c.domain === "privacy" || ["password-hashing", "encryption", "authn", "authz"].includes(c.key)).map((c) => (!inventory.length && c.domain === "privacy" && c.status === "missing" ? { ...c, status: "na" as const, detail: "No personal data was found, so this control does not apply." } : c));
  const ctl = (k: string) => privacyControls.find((c) => c.key === k);
  const missing = (k: string) => ctl(k)?.status === "missing";

  const special = inventory.filter((f) => f.sensitivity === "special");
  // A hashed password is a well-protected credential, not high-sensitivity exposure.
  const high = inventory.filter((f) => f.sensitivity === "high" && !(f.category === "credential" && f.protection !== "none"));
  const unprotected = inventory.filter((f) => (f.sensitivity === "special" || f.sensitivity === "high") && f.protection === "none" && f.category !== "credential");
  const valuesInSource = relevant.filter((f) => /^Personal data written into/.test(f.title)).length;

  // ---- status ----------------------------------------------------------------------------------------------------------
  const severe = relevant.filter((f) => f.severity === "Critical" || f.severity === "High");
  const medium = relevant.filter((f) => f.severity === "Medium");
  let status: PrivacyAssessment["status"];
  if (!inventory.length && !relevant.length) status = "No personal data detected";
  else if (severe.length || (unprotected.length && missing("encryption"))) status = "High exposure";
  else if (medium.length || (inventory.length && (missing("erasure") || missing("log-redaction")))) status = "Needs attention";
  else if (inventory.length <= 3 && !special.length && !high.length) status = "Limited personal data";
  else status = "Controls in place";

  const rationale: string[] = [];
  if (inventory.length) rationale.push(`${inventory.length} personal-data field${inventory.length > 1 ? "s" : ""} in ${piiModels.size} data model${piiModels.size > 1 ? "s" : ""}${special.length ? `, including ${special.length} special-category field${special.length > 1 ? "s" : ""} (${[...new Set(special.map((f) => f.categoryLabel.toLowerCase()))].join(", ")})` : ""}${high.length ? `${special.length ? " and" : ", including"} ${high.length} high-sensitivity field${high.length > 1 ? "s" : ""} (${[...new Set(high.map((f) => f.categoryLabel.toLowerCase()))].join(", ")})` : ""}.`);
  else rationale.push("No data-model field was recognised as personal data. Personal data held in unstructured fields, documents or external systems would not be detected.");
  if (severe.length) rationale.push(`${severe.length} high or critical issue${severe.length > 1 ? "s" : ""} put personal data at risk: ${severe.slice(0, 3).map((f) => `${f.code} ${f.title}`).join("; ")}.`);
  if (unprotected.length) rationale.push(`${unprotected.length} sensitive field${unprotected.length > 1 ? "s are" : " is"} stored without protection visible in the field name${missing("encryption") ? ", and no application-level encryption was found" : ""}.`);
  if (recipients.length) rationale.push(`${recipients.length} third-party service${recipients.length > 1 ? "s are" : " is"} likely to receive personal data: ${recipients.map((r) => r.name).slice(0, 6).join(", ")}.`);
  const privMissing = privacyControls.filter((c) => c.domain === "privacy" && c.status === "missing").map((c) => lower(c.name));
  if (inventory.length && privMissing.length) rationale.push(`Privacy controls not found: ${privMissing.join(", ")}.`);

  // ---- regulatory indicators ---------------------------------------------------------------------------------------------
  const cats = new Set(inventory.map((f) => f.category));
  const regimes: PrivacyAssessment["regimes"] = [];
  if (inventory.length) {
    regimes.push({ name: "GDPR / UK GDPR", why: "Applies if the system processes personal data of people in the EU, EEA or UK, or is operated from there. Requires a lawful basis, data minimisation, security (Art. 32), breach notification within 72 hours, and support for access and erasure requests." });
    regimes.push({ name: "CCPA / CPRA and US state privacy laws", why: "Apply to businesses above the size thresholds that process data of California (and other state) residents: notice at collection, the rights to know, delete and correct, and the right to opt out of sale or sharing." });
  }
  if (cats.has("financial") || arch.externalServices.some((s) => s.category === "payments")) regimes.push({ name: "PCI DSS", why: cats.has("financial") ? "The data model holds payment card or bank data. Any system that stores, processes or transmits card data is in PCI DSS scope; card security codes must never be stored." : "A payment provider is integrated. Keep card data on the provider's hosted fields or tokens so these systems stay outside PCI DSS scope." });
  if (cats.has("health") || inventory.some((f) => HEALTH_MODEL.test(f.model))) regimes.push({ name: "HIPAA (US) and GDPR Art. 9", why: "Health information is stored. For a US covered entity or business associate this is protected health information requiring HIPAA safeguards; under GDPR it is special-category data needing explicit consent or another Art. 9 condition." });
  if (cats.has("biometric")) regimes.push({ name: "Biometric privacy laws (BIPA, GDPR Art. 9)", why: "Biometric identifiers are stored. Illinois BIPA and similar laws require written consent, a published retention schedule and destruction rules, with statutory damages per violation." });
  if (cats.has("demographic")) regimes.push({ name: "GDPR Art. 9 special categories", why: "Data on race, ethnicity, religion, sexual orientation, political opinion, union membership or criminal records is special-category data that needs an explicit legal condition and heightened protection." });
  if (inventory.some((f) => CHILD_MODEL.test(f.model)) || cats.has("birth")) regimes.push({ name: "Children's data (COPPA, UK Age Appropriate Design Code)", why: "Dates of birth, ages or records about children or students are stored. Services directed at children under 13 (US) or likely to be used by children (UK) need verifiable parental consent and privacy-by-default settings." });
  if (cats.has("government")) regimes.push({ name: "Data breach notification laws", why: "Government identifiers such as Social Security, passport or national insurance numbers trigger breach-notification duties in every US state and under GDPR, and are prime targets for identity theft." });

  // ---- recommendations ---------------------------------------------------------------------------------------------------
  const recs: PrivacyAssessment["recommendations"] = [];
  for (const f of severe.slice(0, 4)) recs.push({ priority: "Now", action: `${f.code}: ${firstSentence(f.remediation)}`, why: firstSentence(f.businessImpact || f.whyItMatters) });
  if (inventory.length) {
    if (unprotected.length && missing("encryption")) recs.push({ priority: "Now", action: `Encrypt or tokenise the most sensitive fields (${unprotected.slice(0, 4).map((f) => `${f.model}.${f.field}`).join(", ")}) with keys held in a key-management service.`, why: "Limits the damage of a database, backup or log leak to data an attacker cannot read." });
    if (missing("log-redaction")) recs.push({ priority: "Next", action: "Configure log and error-tracker redaction for personal-data keys (email, phone, password, token, address) and log user IDs instead.", why: "Logs are widely accessible and rarely covered by retention or deletion." });
    if (missing("erasure")) recs.push({ priority: "Next", action: "Build an account deletion or anonymisation flow that covers every table and processor holding the person's data.", why: "Erasure requests are a legal right in most privacy laws and are otherwise handled by hand." });
    if (missing("export")) recs.push({ priority: "Later", action: "Add a data export so people can receive a copy of their data (subject access and portability).", why: "Access requests must be answered within a month under GDPR and 45 days under CCPA." });
    if (missing("retention")) recs.push({ priority: "Later", action: "Define retention periods for each kind of personal data and delete or anonymise it automatically when they expire.", why: "Keeping data indefinitely breaches storage-limitation rules and enlarges any breach." });
    if (missing("consent") && (arch.externalServices.some((s) => s.category === "analytics") || cats.has("contact"))) recs.push({ priority: "Later", action: "Record consent for marketing and non-essential cookies or analytics, with the time and the wording that was agreed to.", why: "Consent must be demonstrable, and analytics cookies need prior consent in the EU and UK." });
    if (recipients.length) recs.push({ priority: "Next", action: `Keep a record of processing and confirm data processing agreements with ${recipients.map((r) => r.name).slice(0, 5).join(", ")}; send them only the fields they need.`, why: "Controllers are accountable for what processors do with the data they are sent." });
    if (arch.externalServices.some((s) => s.category === "ai")) recs.push({ priority: "Next", action: "Strip or pseudonymise personal data before sending prompts to AI providers, and check the provider's retention and training terms.", why: "Prompts can carry personal data to a third party outside your normal controls." });
    if (missing("privacy-notice")) recs.push({ priority: "Later", action: "Document what personal data the system collects, why, where it is stored, who receives it and how long it is kept (a data inventory and privacy notice).", why: "Transparency is required by every major privacy law, and the inventory makes the other duties manageable." });
  }
  for (const f of medium.slice(0, 4)) recs.push({ priority: "Next", action: `${f.code}: ${firstSentence(f.remediation)}`, why: firstSentence(f.businessImpact || f.whyItMatters) });

  recs.sort((a, b) => ["Now", "Next", "Later"].indexOf(a.priority) - ["Now", "Next", "Later"].indexOf(b.priority));
  return {
    status, rationale, fields: inventory, models: [...piiModels.values()], subjects, recipients, flows, controls: privacyControls, findings: refs, regimes, recommendations: recs,
    counts: { fields: inventory.length, special: special.length, high: high.length, unprotectedSensitive: unprotected.length, models: piiModels.size, recipients: recipients.length, findings: refs.length, valuesInSource },
  };
}
