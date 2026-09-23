import fs from "node:fs";
import path from "node:path";
import { eq, desc } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { strToU8, zipSync, type Zippable } from "fflate";
import yauzl from "yauzl";
import { z } from "zod";
import { config } from "../config";
import { getDb, schema, projectRows } from "../db/client";
import type { DocReport } from "../docs/types";
import { docIndexEntries } from "../docs";
import { exportFile } from "../export";
import { loadReportData } from "../export/markdown";
import { redactSecrets } from "../ingest/secrets";
import { buildSearchIndex, indexFindingsAndDocs } from "../retrieval";
import { AppError } from "../util/errors";
import { newId, sha256 } from "../util/ids";
import { LAUNCHER_BAT, LAUNCHER_SH, README_TEXT } from "./launchers";

/**
 * A Brody bundle is a ZIP holding a complete analysis: the data behind every Brody view, the source it was made from
 * (with detected secrets redacted), ready-made reports, and launchers. Importing a bundle recreates the project in any
 * Brody instance, with the full interface, without re-running the analysis.
 */
export const BUNDLE_FORMAT = "brody-bundle";
export const BUNDLE_VERSION = 1;

const ManifestSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.number().int().min(1),
  createdAt: z.number(),
  brodyVersion: z.string().optional(),
  sourceRedacted: z.boolean().optional(),
  project: z.object({ name: z.string(), sourceType: z.string() }).passthrough(),
  counts: z.record(z.string(), z.number()).optional(),
});
export type BundleManifest = z.infer<typeof ManifestSchema>;

const ID_RE = /\b(?:prj|f|sym|rel|fnd|job|q|flow)_[0-9a-f]{20}\b/g;

let version: string | undefined;
/** Read once per process: the version cannot change while the server runs. */
function brodyVersion(): string {
  // brody-ignore: sync-io (once per process)
  try { version ??= (JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string }).version ?? "unknown"; } catch { version = "unknown"; }
  return version;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "project";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export interface BundleResult { body: Buffer; filename: string; manifest: BundleManifest }

export async function buildBundle(projectId: string): Promise<BundleResult> {
  const { project, docs } = loadReportData(projectId);
  const db = getDb();
  const files = projectRows(schema.files, projectId);
  const symbols = projectRows(schema.symbols, projectId);
  const relationships = projectRows(schema.relationships, projectId);
  const findings = projectRows(schema.findings, projectId);
  const questions = db.select().from(schema.questions).where(eq(schema.questions.projectId, projectId)).all();
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId)).orderBy(desc(schema.jobs.createdAt)).limit(1).get();

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, createdAt: Date.now(), brodyVersion: brodyVersion(), sourceRedacted: true,
    project: { name: project.name, sourceType: project.sourceType, sourceUrl: project.sourceUrl, branch: project.branch, commit: project.commit, owner: project.owner, fileCount: project.fileCount, lineCount: project.lineCount },
    counts: { files: files.length, symbols: symbols.length, relationships: relationships.length, findings: findings.length, questions: questions.length },
  };

  const zip: Zippable = {};
  const put = (name: string, data: string | Uint8Array, opts: { level?: 0 | 6; exec?: boolean } = {}) => {
    const bytes = typeof data === "string" ? strToU8(data) : data;
    zip[name] = [bytes, { level: opts.level ?? 6, mtime: new Date(), ...(opts.exec ? { os: 3, attrs: 0o100755 << 16 } : {}) }];
  };
  put("manifest.json", JSON.stringify(manifest, null, 2));
  put("README.txt", README_TEXT(project.name));
  put("Open in Brody.command", LAUNCHER_SH, { exec: true });
  put("open-in-brody.sh", LAUNCHER_SH, { exec: true });
  put("Open in Brody.bat", LAUNCHER_BAT);

  put("data/project.json", JSON.stringify(project));
  put("data/files.json", JSON.stringify(files));
  put("data/symbols.json", JSON.stringify(symbols));
  put("data/relationships.json", JSON.stringify(relationships));
  put("data/findings.json", JSON.stringify(findings));
  put("data/questions.json", JSON.stringify(questions));
  put("data/jobs.json", JSON.stringify(job ? [job] : []));

  // Source, with anything that looks like a credential redacted. Stored once, under its own path, so the tree is browsable.
  const hashes = [...new Set(files.filter((f) => f.hasContent).map((f) => f.hash))];
  const blobByHash = new Map<string, string>();
  for (let i = 0; i < hashes.length; i += 200) {
    for (const h of hashes.slice(i, i + 200)) {
      const row = db.select().from(schema.blobs).where(eq(schema.blobs.hash, h)).get();
      if (row) blobByHash.set(h, row.content);
    }
  }
  for (const f of files) {
    if (!f.hasContent) continue;
    const content = blobByHash.get(f.hash);
    if (content !== undefined) put(`source/${f.path}`, redactSecrets(content));
  }

  // Ready-made reports for reading without Brody at all.
  const [pdf, docx, md, html, complete] = await Promise.all([
    exportFile(projectId, "pdf", "full"), exportFile(projectId, "docx", "full"), exportFile(projectId, "md", "full"), exportFile(projectId, "html", "full"), exportFile(projectId, "md", "complete"),
  ]);
  const buf = (r: { body: string | Buffer }) => (typeof r.body === "string" ? strToU8(r.body) : new Uint8Array(r.body));
  put("reports/Report.pdf", buf(pdf), { level: 0 });
  put("reports/Report.docx", buf(docx), { level: 0 });
  put("reports/Report.md", buf(md));
  put("reports/Report.html", buf(html));
  put("reports/Complete-Technical-Report.md", buf(complete));

  const body = Buffer.from(zipSync(zip));
  void docs;
  return { body, filename: `${safeName(project.name)}-brody-bundle.zip`, manifest };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
const invalid = (message: string, hint = "Export the project again from Brody and retry.") => new AppError("invalid_bundle", message, 400, hint);

/** Read the parts of a bundle that import needs, defensively: entry, size and compression-ratio limits; nothing touches disk. */
async function readBundle(buffer: Buffer, want: (name: string) => boolean): Promise<Map<string, Buffer>> {
  const { maxZipEntries, maxTotalBytes, maxZipRatio } = config.limits;
  const out = new Map<string, Buffer>();
  let entries = 0;
  let total = 0;
  const zf = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (err, z) => (err || !z ? reject(new AppError("bad_zip", `That is not a valid ZIP archive: ${err?.message ?? "unknown error"}`, 400, "Choose a .zip file exported by Brody.")) : resolve(z)));
  });
  await new Promise<void>((resolve, reject) => {
    zf.on("error", (e: Error) => reject(new AppError("bad_zip", `The archive could not be read: ${e.message}`, 400)));
    zf.on("end", () => resolve());
    zf.on("entry", (entry: yauzl.Entry) => {
      entries++;
      if (entries > maxZipEntries * 2) return reject(new AppError("bundle_too_large", "That archive has too many entries.", 413));
      if (/\/$/.test(entry.fileName) || !want(entry.fileName)) return zf.readEntry();
      if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > maxZipRatio * 4 && entry.uncompressedSize > 1_000_000) return reject(new AppError("bundle_unsafe", `Rejected "${entry.fileName}": its compression ratio looks like a zip bomb.`, 400));
      total += entry.uncompressedSize;
      if (total > maxTotalBytes) return reject(new AppError("bundle_too_large", "That bundle expands to more data than this Brody accepts.", 413, "Raise MAX_TOTAL_BYTES, or export a smaller project."));
      zf.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(new AppError("bad_zip", `Could not read "${entry.fileName}".`, 400));
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("error", (e) => reject(new AppError("bad_zip", `Could not read "${entry.fileName}": ${e.message}`, 400)));
        stream.on("end", () => { out.set(entry.fileName, Buffer.concat(chunks)); zf.readEntry(); });
      });
    });
    zf.readEntry();
  });
  return out;
}

/** Whether a ZIP is a Brody bundle, judged by its manifest alone (cheap; nothing else is inflated). */
export async function isBundleZip(buffer: Buffer): Promise<boolean> {
  try {
    const parts = await readBundle(buffer, (n) => n === "manifest.json");
    const raw = parts.get("manifest.json");
    return !!raw && (JSON.parse(raw.toString("utf8")) as { format?: string }).format === BUNDLE_FORMAT;
  } catch {
    return false;
  }
}

type AnyTable = typeof schema.projects | typeof schema.files | typeof schema.symbols | typeof schema.relationships | typeof schema.findings | typeof schema.questions | typeof schema.jobs;

/** Keep only known columns and check each value's type, so a crafted bundle cannot put arbitrary data into the database. */
function cleanRows(label: string, table: AnyTable, rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) throw invalid(`The bundle's ${label} data is not a list.`);
  const cols = getTableColumns(table) as Record<string, { dataType: string; notNull: boolean; hasDefault: boolean }>;
  return rows.map((r, i) => {
    if (!r || typeof r !== "object") throw invalid(`${label}[${i}] is not an object.`);
    const row: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(cols)) {
      const v = (r as Record<string, unknown>)[key];
      if (v === undefined || v === null) {
        if (v === null) { if (col.notNull && !col.hasDefault) throw invalid(`${label}[${i}].${key} must not be empty.`); row[key] = null; }
        else if (col.notNull && !col.hasDefault) throw invalid(`${label}[${i}] is missing "${key}".`);
        continue;
      }
      const ok = col.dataType === "json" ? typeof v === "object" : typeof v === col.dataType;
      if (!ok) throw invalid(`${label}[${i}].${key} has the wrong type (expected ${col.dataType}).`);
      row[key] = v;
    }
    return row;
  });
}

const parseJson = (parts: Map<string, Buffer>, name: string): unknown => {
  const raw = parts.get(name);
  if (!raw) throw invalid(`The bundle is missing ${name}.`);
  try { return JSON.parse(raw.toString("utf8")); } catch { throw invalid(`${name} in the bundle is not valid JSON.`); }
};

export interface ImportResult { projectId: string; warnings: string[]; manifest: BundleManifest }

/** Recreate a project from a bundle: new ids throughout, content restored, search index rebuilt. No re-analysis is run. */
export async function importBundle(buffer: Buffer): Promise<ImportResult> {
  const parts = await readBundle(buffer, (n) => n === "manifest.json" || n.startsWith("data/") || n.startsWith("source/"));
  const manifestRaw = parts.get("manifest.json");
  if (!manifestRaw) throw invalid("That ZIP is not a Brody export: it has no manifest.json.", "Choose the .zip that Brody produced with Export > Brody bundle.");
  let manifest: BundleManifest;
  try { manifest = ManifestSchema.parse(JSON.parse(manifestRaw.toString("utf8"))); } catch { throw invalid("The bundle's manifest is not valid."); }
  if (manifest.version > BUNDLE_VERSION) throw invalid(`This bundle was made by a newer Brody (bundle version ${manifest.version}); this one understands up to ${BUNDLE_VERSION}.`, "Update Brody, then import it again.");

  const projectRows = cleanRows("project", schema.projects, [parseJson(parts, "data/project.json")]);
  const fileRows = cleanRows("files", schema.files, parseJson(parts, "data/files.json"));
  const symbolRows = cleanRows("symbols", schema.symbols, parseJson(parts, "data/symbols.json"));
  const relRows = cleanRows("relationships", schema.relationships, parseJson(parts, "data/relationships.json"));
  const findingRows = cleanRows("findings", schema.findings, parseJson(parts, "data/findings.json"));
  const questionRows = cleanRows("questions", schema.questions, parseJson(parts, "data/questions.json"));
  const jobRows = cleanRows("jobs", schema.jobs, parseJson(parts, "data/jobs.json"));
  if (projectRows.length !== 1) throw invalid("The bundle must hold exactly one project.");

  // Fresh ids everywhere, so the same bundle can be imported twice and never collides with existing rows. Ids appear
  // inside JSON blobs too (analysis, docs), so every occurrence of a known id is replaced.
  const idMap = new Map<string, string>();
  const known = (id: unknown, what: string) => {
    if (typeof id !== "string" || !new RegExp(`^${ID_RE.source}$`).test(id)) throw invalid(`The bundle contains an unexpected ${what} id.`);
    if (!idMap.has(id)) idMap.set(id, newId(id.slice(0, id.indexOf("_"))));
  };
  known(projectRows[0].id, "project");
  for (const [rows, what] of [[fileRows, "file"], [symbolRows, "symbol"], [relRows, "relationship"], [findingRows, "finding"], [questionRows, "question"], [jobRows, "job"]] as const) for (const r of rows) known(r.id, what);
  const remap = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(ID_RE, (m) => idMap.get(m) ?? m)) as T;

  const projectId = idMap.get(projectRows[0].id as string)!;
  const warnings: string[] = [];
  const now = Date.now();
  const project = remap(projectRows[0]);
  const analysis = (project.analysis ?? {}) as Record<string, unknown>;
  if (!analysis.architecture || !analysis.docs) throw invalid("The bundle does not contain a finished analysis.");
  project.analysis = { ...analysis, imported: { at: now, exportedAt: manifest.createdAt, brodyVersion: manifest.brodyVersion ?? null, sourceRedacted: manifest.sourceRedacted ?? false } };
  Object.assign(project, { status: "ready", previousProjectId: null, incremental: null, createdAt: now, updatedAt: now });

  // File content: restored from source/<path>, stored under its own hash.
  const blobRows: { hash: string; content: string; size: number }[] = [];
  const files = remap(fileRows).map((f) => {
    if (!f.hasContent) return f;
    const raw = parts.get(`source/${f.path as string}`);
    if (!raw) { warnings.push(`No source was included for ${f.path as string}.`); return { ...f, hasContent: false }; }
    const content = raw.toString("utf8");
    const hash = sha256(content);
    blobRows.push({ hash, content, size: Buffer.byteLength(content) });
    return { ...f, hash };
  });

  const db = getDb();
  const chunk = <T>(rows: T[], n = 100): T[][] => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(i * n, i * n + n));
  db.transaction((tx) => {
    tx.insert(schema.projects).values(project as typeof schema.projects.$inferInsert).run();
    for (const c of chunk(blobRows, 50)) tx.insert(schema.blobs).values(c).onConflictDoNothing().run();
    for (const c of chunk(files)) tx.insert(schema.files).values(c as (typeof schema.files.$inferInsert)[]).run();
    for (const c of chunk(remap(symbolRows))) tx.insert(schema.symbols).values(c as (typeof schema.symbols.$inferInsert)[]).run();
    for (const c of chunk(remap(relRows))) tx.insert(schema.relationships).values(c as (typeof schema.relationships.$inferInsert)[]).run();
    for (const c of chunk(remap(findingRows))) tx.insert(schema.findings).values(c as (typeof schema.findings.$inferInsert)[]).run();
    for (const c of chunk(remap(questionRows))) tx.insert(schema.questions).values(c as (typeof schema.questions.$inferInsert)[]).run();
    for (const c of chunk(remap(jobRows))) tx.insert(schema.jobs).values(c as (typeof schema.jobs.$inferInsert)[]).run();
  });

  // The search index is derived data; rebuild it rather than trusting the bundle for it.
  await buildSearchIndex(projectId, { embed: false });
  indexFindingsAndDocs(projectId, docIndexEntries((project.analysis as { docs: DocReport }).docs));
  return { projectId, warnings, manifest };
}
