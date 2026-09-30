import { beforeAll, describe, expect, it } from "vitest";
import { scanText } from "@/lib/analysis/rules";
import { classifyField, classifyFinding, detectPiiValues, loadAssurance } from "@/lib/assurance";
import { detectControls } from "@/lib/assurance/controls";
import type { Architecture } from "@/lib/discover/types";
import { getDb, schema } from "@/lib/db/client";
import { buildMarkdown, exportFile, SCOPES } from "@/lib/export";
import { issueFor } from "@/lib/deck/lexicon";
import { eq } from "drizzle-orm";
import { analyze, fixtureFiles, freshDb, fromStrings } from "./helpers";

const ids = (lang: string, text: string, path = "src/x.ts") => scanText(path, lang, text, false).map((f) => f.analyzer!.replace("brody-rules/", ""));

describe("personal-data field taxonomy", () => {
  it("classifies personal data by category and sensitivity, and reads protection from the name", () => {
    expect(classifyField("email", "User")).toMatchObject({ category: { key: "contact", sensitivity: "moderate" }, protection: "none" });
    expect(classifyField("ssn", "Patient")?.category.key).toBe("government");
    expect(classifyField("diagnosis", "Visit")?.category).toMatchObject({ key: "health", sensitivity: "special" });
    expect(classifyField("date_of_birth", "Customer")?.category.key).toBe("birth");
    expect(classifyField("passwordHash", "User")).toMatchObject({ category: { key: "credential" }, protection: "hashed" });
    expect(classifyField("password", "User")).toMatchObject({ category: { key: "credential" }, protection: "none" });
    expect(classifyField("ssnEncrypted", "Patient")).toMatchObject({ category: { key: "government" }, protection: "encrypted" });
    expect(classifyField("cardLast4", "PaymentMethod")).toMatchObject({ category: { key: "financial" }, protection: "tokenised" });
    expect(classifyField("bloodType", "Patient")?.category.key).toBe("health");
    expect(classifyField("latitude", "Store")?.category.key).toBe("address");
  });
  it("ignores flags, metadata and identifiers that only mention personal data", () => {
    for (const f of ["emailVerified", "passwordChangedAt", "passwordResetRequired", "email_template", "phoneVerifiedAt", "id", "userId", "createdAt", "status", "totalCents"]) expect(classifyField(f, "User"), f).toBeUndefined();
    // A bare "name" is a personal name only on a record about a person.
    expect(classifyField("name", "Customer")?.category.key).toBe("name");
    expect(classifyField("name", "Product")).toBeUndefined();
  });
});

describe("personal data written into source", () => {
  it("finds consumer e-mail addresses, labelled SSNs and real card numbers, and masks them", () => {
    const hits = detectPiiValues(["const owner = 'jane.doe@gmail.com';", "ssn: '123-45-6789',", "card = '4539 1488 0343 6467'"].join("\n"));
    expect(hits.map((h) => h.kind)).toEqual(["Personal e-mail address", "US Social Security number", "Payment card number"]);
    expect(hits.map((h) => h.preview).join(" ")).not.toMatch(/jane\.doe|123-45|4539 1488/);
  });
  it("leaves example addresses, published test cards, unlabelled numbers and placeholders alone", () => {
    expect(detectPiiValues(["support@example.com", "ops@acme.io", "4242 4242 4242 4242", "4111111111111111", "order 123-45-6789", "const sample = 'john@gmail.com'", "1234567812345678"].join("\n"))).toHaveLength(0);
  });
});

describe("privacy rules", () => {
  it("flags personal data or request bodies in log statements, but not in log messages", () => {
    expect(ids("TypeScript", "console.log('login', user.email);")).toContain("pii-logging");
    expect(ids("TypeScript", "logger.info({ body: req.body });")).toContain("pii-logging");
    expect(ids("Python", "logging.info('reset for %s', password)", "app/x.py")).toContain("pii-logging");
    expect(ids("TypeScript", "logger.info('password reset requested', { userId });")).not.toContain("pii-logging");
    expect(ids("TypeScript", "console.log('email sent');")).not.toContain("pii-logging");
  });
  it("flags personal data or secrets placed in a query string", () => {
    expect(ids("TypeScript", "fetch(`/api/users?email=${email}`)")).toContain("pii-in-url");
    expect(ids("TypeScript", "const u = '/lookup?ssn=' + ssn;")).toContain("pii-in-url");
    expect(ids("TypeScript", "fetch(`/api/users?page=${page}`)")).not.toContain("pii-in-url");
  });
  it("maps findings to OWASP Top 10 and CWE", () => {
    expect(classifyFinding({ analyzer: "brody-rules/sql-concat", title: "SQL", category: "Security" })).toEqual({ owasp: "A03", cwe: "CWE-89" });
    expect(classifyFinding({ analyzer: "brody-rules/pii-logging", title: "x", category: "Privacy" })).toEqual({ owasp: "A09", cwe: "CWE-532" });
    expect(classifyFinding({ analyzer: "ai-review", title: "Order lookup lets a user read another user's orders (IDOR)", category: "Security" })).toEqual({ owasp: "A01", cwe: "CWE-862" });
    expect(classifyFinding({ analyzer: "brody-structure", title: "npm dependencies are not locked", category: "Dependencies" }).owasp).toBe("A06");
    expect(classifyFinding({ analyzer: "eslint/no-unused-vars", title: "unused", category: "Correctness" })).toEqual({});
  });
});

describe("control detection", () => {
  const arch = { dependencies: [], externalServices: [], routes: [], envVars: [], secrets: [] } as unknown as Architecture;
  const status = (files: { path: string; text: string; classification?: string }[], key: string) =>
    detectControls(files.map((f) => ({ classification: "source", isTest: false, ...f })), arch).find((c) => c.key === key)?.status;
  it("counts a control only when the code uses it, not when a scanner or a comment mentions it", () => {
    expect(status([{ path: "src/app.ts", text: "app.use(rateLimit({ windowMs: 60_000, max: 100 }));" }], "rate-limit")).toBe("present");
    expect(status([{ path: "src/scan.ts", text: "const RE = /\\b(?:rateLimit\\s*\\(|RateLimiter)/;" }], "rate-limit")).toBe("missing");
    expect(status([{ path: "src/app.ts", text: "// TODO: add rateLimit() here\nconst x = 1;" }], "rate-limit")).toBe("missing");
    expect(status([{ path: "src/msg.ts", text: "const help = 'call bcrypt.hash first';" }], "password-hashing")).toBe("missing");
  });
  it("reads header names and CI steps from strings and configuration", () => {
    expect(status([{ path: "next.config.ts", text: "headers: [{ key: 'Content-Security-Policy', value: \"default-src 'self'\" }]" }], "headers")).toBe("present");
    expect(status([{ path: ".github/workflows/ci.yml", text: "      - run: npm audit --audit-level=high", classification: "ci" }], "dependency-scanning")).toBe("present");
  });
  it("recognises a privacy notice by its file, not by any path that mentions privacy", () => {
    expect(status([{ path: "docs/PRIVACY.md", text: "# Privacy", classification: "docs" }], "privacy-notice")).toBe("present");
    expect(status([{ path: "src/app/privacy/page.tsx", text: "export default function P() {}" }], "privacy-notice")).toBe("present");
    expect(status([{ path: "src/lib/privacy.ts", text: "export const x = 1;" }], "privacy-notice")).toBe("missing");
  });
});

// A small clinic backend with the privacy problems the review exists to catch.
const clinic = {
  "package.json": JSON.stringify({ name: "clinic", dependencies: { express: "^4.19.0", pg: "^8.11.0", "@sentry/node": "^8.0.0" } }),
  "migrations/001_init.sql": [
    "CREATE TABLE patients (", "  id SERIAL PRIMARY KEY,", "  full_name TEXT NOT NULL,", "  email TEXT NOT NULL,", "  password TEXT NOT NULL,", "  ssn TEXT,", "  date_of_birth DATE,", "  diagnosis TEXT", ");",
    "CREATE TABLE payment_cards (", "  id SERIAL PRIMARY KEY,", "  patient_id INTEGER REFERENCES patients(id),", "  card_number TEXT,", "  cvv TEXT", ");",
  ].join("\n"),
  "src/server.ts": [
    "import express from 'express';",
    "import { db } from './db';",
    "const app = express();",
    "app.use(express.json());",
    "app.post('/api/patients', async (req, res) => {",
    "  console.log('new patient', req.body);",
    "  const row = await db.query('INSERT INTO patients (full_name, email, password, ssn) VALUES ($1, $2, $3, $4)', [req.body.fullName, req.body.email, req.body.password, req.body.ssn]);",
    "  res.json(row);",
    "});",
    "app.get('/api/patients/:id', async (req, res) => {",
    "  const r = await db.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);",
    "  res.json(r.rows[0]);",
    "});",
    "app.get('/api/lookup', async (req, res) => {",
    "  const r = await fetch(`https://records.internal/find?email=${req.query.email}`);",
    "  res.json(await r.json());",
    "});",
    "app.listen(3000);",
  ].join("\n"),
  "src/db.ts": "import { Pool } from 'pg';\nexport const db = new Pool({ connectionString: process.env.DATABASE_URL });\n",
  "src/seed.ts": "export const admins = [\n  { name: 'Dana Whitfield', email: 'dana.whitfield@gmail.com' },\n  { name: 'Omar Haddad', email: 'omar.haddad@yahoo.com' },\n];\n",
};

describe("security assessment and PII review in the pipeline", () => {
  let pid: string;
  beforeAll(async () => {
    freshDb();
    pid = (await analyze(fromStrings(clinic), "clinic")).projectId;
  });

  it("raises deterministic privacy findings with PRV codes and executive wording", () => {
    const rows = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, pid)).all();
    const titles = rows.map((f) => `${f.code} ${f.title}`);
    expect(titles.some((t) => /^SEC-\d+ Passwords appear to be stored without hashing/.test(t))).toBe(true);
    expect(titles.some((t) => /^PRV-\d+ Card security code stored/.test(t))).toBe(true);
    expect(titles.some((t) => /^PRV-\d+ Sensitive personal data stored without field-level encryption/.test(t))).toBe(true);
    expect(titles.some((t) => /^PRV-\d+ Personal data or credentials written to logs/.test(t))).toBe(true);
    expect(titles.some((t) => /^PRV-\d+ Personal data or secrets placed in a URL/.test(t))).toBe(true);
    expect(titles.some((t) => /^PRV-\d+ Personal data written into src\/seed\.ts/.test(t))).toBe(true);
    const seed = rows.find((f) => f.filePath === "src/seed.ts")!;
    expect(seed.evidence).not.toMatch(/dana\.whitfield|omar\.haddad/);
    for (const f of rows.filter((x) => x.analyzer === "brody-privacy")) expect(issueFor(f).issue, f.title).not.toMatch(/^A risk to customers/);
  });

  it("builds a field-level PII inventory, status, recipients and regulatory indicators", () => {
    const { privacy } = loadAssurance(pid);
    expect(privacy.status).toBe("High exposure");
    const byField = new Map(privacy.fields.map((f) => [`${f.model}.${f.field}`, f]));
    expect(byField.get("patients.ssn")).toMatchObject({ category: "government", protection: "none" });
    expect(byField.get("patients.diagnosis")?.sensitivity).toBe("special");
    expect(byField.get("payment_cards.cvv")?.category).toBe("financial");
    expect(privacy.subjects).toContain("Patients");
    expect(privacy.regimes.map((r) => r.name)).toEqual(expect.arrayContaining(["GDPR / UK GDPR", "PCI DSS", "HIPAA (US) and GDPR Art. 9"]));
    expect(privacy.controls.find((c) => c.key === "erasure")?.status).toBe("missing");
    expect(privacy.recommendations[0].priority).toBe("Now");
  });

  it("rates security risk with OWASP coverage, controls and a remediation plan", () => {
    const { security } = loadAssurance(pid);
    expect(["Critical", "High"]).toContain(security.rating);
    expect(security.owasp).toHaveLength(10);
    expect(security.owasp.find((o) => o.id === "A06")?.status).not.toBe("clear");
    expect(security.owasp.find((o) => o.id === "A09")?.findings.some((f) => f.cwe === "CWE-532")).toBe(true);
    expect(security.controls.find((c) => c.key === "password-hashing")?.status).toBe("missing");
    expect(security.surface.unauthenticatedWrites.map((r) => r.path)).toContain("/api/patients");
    expect(security.plan[0].priority).toBe("Now");
  });

  it("exports both as numbered reports, and as sections of the main reports", async () => {
    for (const scope of ["security", "privacy"] as const) {
      const md = buildMarkdown(pid, { scope });
      expect(md.startsWith(`# ${SCOPES[scope].title}`)).toBe(true);
      expect([...md.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]))).toEqual(SCOPES[scope].sections.map((_, i) => i + 1));
      const pdf = await exportFile(pid, "pdf", scope);
      expect(pdf.filename).toBe(`clinic-${SCOPES[scope].slug}.pdf`);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
      const docx = await exportFile(pid, "docx", scope);
      expect((docx.body as Buffer).length).toBeGreaterThan(2000);
    }
    const sec = buildMarkdown(pid, { scope: "security" });
    expect(sec).toContain("OWASP Top 10 (2021) Coverage");
    expect(sec).toMatch(/\| \*\*A03\*\* Injection \|/);
    const priv = buildMarkdown(pid, { scope: "privacy" });
    expect(priv).toContain("Personal data status: High exposure");
    expect(priv).toContain("`patients.ssn`");
    expect(priv).not.toMatch(/dana\.whitfield|omar\.haddad/);
    const full = buildMarkdown(pid);
    expect(full).toMatch(/^## \d+\. Security Assessment$/m);
    expect(full).toMatch(/^## \d+\. Privacy & PII Review$/m);
  });
});

describe("the sample shop", () => {
  it("reports its committed secret, injection flaws and personal data honestly", async () => {
    freshDb();
    const { projectId } = await analyze(fixtureFiles(), "sample-shop");
    const { security, privacy } = loadAssurance(projectId);
    expect(security.rating).toBe("Critical");
    expect(security.owasp.find((o) => o.id === "A03")?.status).toBe("issues");
    // passwordHash is a hashed credential and is not counted as exposed high-sensitivity data.
    expect(privacy.fields.map((f) => `${f.model}.${f.field}`)).toEqual(expect.arrayContaining(["User.email", "User.passwordHash"]));
    expect(privacy.counts.high).toBe(0);
    expect(privacy.recipients.map((r) => r.name)).toContain("Stripe");
  });
});
