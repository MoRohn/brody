import { guard, json } from "@/lib/api";
import { createUploadSession } from "@/lib/ingest/sessions";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/upload/sessions   { mode, name?, previous?, files: [{ path, size }] }
 * Start an upload of any size up to MAX_UPLOAD_BYTES. Every limit is checked here, before any file is sent; the files
 * follow in pieces (PUT /api/projects/upload/sessions/:id), then POST .../finish ingests them.
 */
export async function POST(req: Request) {
  return guard(async () => {
    const body = await req.json().catch(() => { throw new AppError("invalid_request", "The upload description is not valid JSON.", 400); });
    return json(await createUploadSession(body), 201);
  });
}
