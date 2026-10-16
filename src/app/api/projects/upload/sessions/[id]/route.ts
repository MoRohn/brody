import { guard, json } from "@/lib/api";
import { config } from "@/lib/config";
import { cancelUploadSession, writeUploadPieces } from "@/lib/ingest/sessions";
import { readCappedForm } from "@/lib/util/body";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/projects/upload/sessions/:id   (multipart: repeated index, offset, data) — write pieces of the upload to disk. */
export async function PUT(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const form = await readCappedForm(req, config.limits.maxRequestBytes, "This part of the upload", "Send the upload in smaller pieces, or raise MAX_REQUEST_BYTES.");
    return json(await writeUploadPieces(id, form));
  });
}

/** DELETE /api/projects/upload/sessions/:id — abandon the upload and free its disk space. */
export async function DELETE(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    await cancelUploadSession(id);
    return json({ ok: true });
  });
}
