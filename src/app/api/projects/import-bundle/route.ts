import { eq } from "drizzle-orm";
import { guard, json, projectSummary } from "@/lib/api";
import { importBundle } from "@/lib/bundle";
import { config } from "@/lib/config";
import { getDb, schema } from "@/lib/db/client";
import { readCappedForm } from "@/lib/util/body";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/projects/import-bundle   (multipart, field "file")
 * Recreates a project from a Brody bundle (.zip made by Export > Brody bundle), with the full interface and no re-analysis.
 */
export async function POST(req: Request) {
  return guard(async () => {
    // The size is enforced on the bytes actually received, not on the Content-Length header a client states.
    const form = await readCappedForm(req, config.limits.maxUploadBytes, "The file");
    const file = form.get("file");
    if (!file || typeof file === "string") throw new AppError("invalid_request", "No file was sent.", 400, "Choose a Brody bundle .zip.");
    const { projectId, warnings } = await importBundle(Buffer.from(await (file as File).arrayBuffer()));
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!;
    return json({ project: projectSummary(p), warnings, imported: true }, 201);
  });
}
