import { getReadyProject, guard } from "@/lib/api";
import { DECK_FORMATS, exportDeck, isDeckFormat } from "@/lib/deck";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/:id/deck?format=html|pptx|pdf&download=0|1
 * The executive summary deck, built from the same stored analysis as the report. download=0 shows HTML and PDF in the browser.
 */
export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    const u = new URL(req.url);
    const format = (u.searchParams.get("format") ?? "html").toLowerCase().replace("powerpoint", "pptx");
    if (!isDeckFormat(format)) throw new AppError("invalid_request", `Unsupported deck format "${format}".`, 400, `Use one of: ${DECK_FORMATS.join(", ")}.`);
    const inline = u.searchParams.get("download") === "0" && format !== "pptx";
    const f = await exportDeck(id, format);
    return new Response(typeof f.body === "string" ? f.body : new Uint8Array(f.body), {
      headers: { "Content-Type": f.contentType, "Cache-Control": "no-store", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${f.filename}"`, "X-Content-Type-Options": "nosniff" },
    });
  });
}
