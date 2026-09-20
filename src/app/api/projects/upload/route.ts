import { guard, json, projectSummary } from "@/lib/api";
import { config } from "@/lib/config";
import { getDb, schema } from "@/lib/db/client";
import { importBundle, isBundleZip } from "@/lib/bundle";
import { ingestUpload, type UploadedItem, type UploadMode } from "@/lib/ingest/upload";
import { enqueueAnalysis } from "@/lib/jobs";
import { AppError } from "@/lib/util/errors";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODES = new Set(["file", "files", "folder", "zip"]);

export async function POST(req: Request) {
  return guard(async () => {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > config.limits.maxUploadBytes) throw new AppError("upload_too_large", `The upload is ${Math.round(length / 1024 / 1024)} MB; the limit is ${Math.round(config.limits.maxUploadBytes / 1024 / 1024)} MB.`, 413, "Exclude dependencies and build output, or upload a ZIP of just the source.");
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new AppError("invalid_upload", "The upload could not be read as a multipart form.", 400, "Try again, or upload the project as a ZIP archive.");
    }
    const mode = String(form.get("mode") ?? "files") as UploadMode;
    if (!MODES.has(mode)) throw new AppError("invalid_request", `Unknown upload mode "${mode}".`, 400);
    const items: UploadedItem[] = [];
    const entries = form.getAll("files");
    const paths = form.getAll("paths").map(String);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (typeof e === "string") continue;
      const file = e as File;
      items.push({ name: paths[i] || file.name, content: Buffer.from(await file.arrayBuffer()) });
    }
    // A Brody export dropped here is opened, not analysed as if it were source code.
    if (mode === "zip" && items.length === 1 && (await isBundleZip(items[0].content))) {
      const imported = await importBundle(items[0].content);
      const ip = getDb().select().from(schema.projects).where(eq(schema.projects.id, imported.projectId)).get()!;
      return json({ project: projectSummary(ip), warnings: imported.warnings, imported: true }, 201);
    }
    const name = String(form.get("name") ?? "").trim() || undefined;
    const outcome = await ingestUpload(mode, items, { name });
    const job = enqueueAnalysis(outcome.projectId);
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, outcome.projectId)).get()!;
    return json({ project: projectSummary(p), jobId: job.id, warnings: outcome.warnings, stats: { included: outcome.stats.included, excluded: outcome.stats.excluded, binary: outcome.stats.binary } }, 201);
  });
}
