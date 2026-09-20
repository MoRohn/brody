import { eq } from "drizzle-orm";
import { guard, json, projectSummary } from "@/lib/api";
import { importBundle } from "@/lib/bundle";
import { config } from "@/lib/config";
import { getDb, schema } from "@/lib/db/client";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/projects/import-bundle   (multipart, field "file")
 * Recreates a project from a Brody bundle (.zip made by Export > Brody bundle), with the full interface and no re-analysis.
 */
export async function POST(req: Request) {
  return guard(async () => {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > config.limits.maxUploadBytes) throw new AppError("upload_too_large", `The file is ${Math.round(length / 1024 / 1024)} MB; the limit is ${Math.round(config.limits.maxUploadBytes / 1024 / 1024)} MB.`, 413, "Raise MAX_UPLOAD_BYTES, or export a smaller project.");
    let form: FormData;
    try { form = await req.formData(); } catch { throw new AppError("invalid_upload", "The upload could not be read as a multipart form.", 400, "Send the .zip as the multipart field \"file\"."); }
    const file = form.get("file");
    if (!file || typeof file === "string") throw new AppError("invalid_request", "No file was sent.", 400, "Choose a Brody bundle .zip.");
    const { projectId, warnings } = await importBundle(Buffer.from(await (file as File).arrayBuffer()));
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    return json({ project: projectSummary(p), warnings, imported: true }, 201);
  });
}
