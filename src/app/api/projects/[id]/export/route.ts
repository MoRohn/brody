import { getReadyProject, guard } from "@/lib/api";
import { buildBundle } from "@/lib/bundle";
import { exportFile, FORMATS, isFormat, isScope, SCOPES } from "@/lib/export";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/:id/export?format=pdf|docx|md|html|json|print|bundle&scope=full|complete|review|explain|architecture|map|ask&download=0|1
 * format=bundle is the whole project as a ZIP that Brody can open again with the full interface (scope is always the whole project).
 * download=0 serves the file inline so the browser can display it (PDF, HTML, Markdown as text).
 */
export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    const u = new URL(req.url);
    const format = (u.searchParams.get("format") ?? "md").toLowerCase().replace("markdown", "md");
    const scope = (u.searchParams.get("scope") ?? "full").toLowerCase();
    if (format === "bundle") {
      const b = await buildBundle(id);
      return new Response(new Uint8Array(b.body), { headers: { "Content-Type": "application/zip", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${b.filename}"`, "X-Content-Type-Options": "nosniff" } });
    }
    if (!isFormat(format)) throw new AppError("invalid_request", `Unsupported export format "${format}".`, 400, `Use one of: ${FORMATS.join(", ")}.`);
    if (!isScope(scope)) throw new AppError("invalid_request", `Unknown report scope "${scope}".`, 400, `Use one of: ${Object.keys(SCOPES).join(", ")}.`);
    if (format === "json" && scope !== "full") throw new AppError("invalid_request", "The JSON export contains the whole repository model and is only available for the full report.", 400, "Use scope=full.");
    const inline = u.searchParams.get("download") === "0" || format === "print";
    const r = await exportFile(id, format, scope);
    const viewable = format === "pdf" || format === "html" || format === "print" || format === "md";
    const disposition = inline && viewable ? "inline" : "attachment";
    // Markdown is shown as plain text when viewed inline so browsers do not offer to download it.
    const contentType = inline && format === "md" ? "text/plain; charset=utf-8" : r.contentType;
    return new Response(typeof r.body === "string" ? r.body : new Uint8Array(r.body), {
      headers: { "Content-Type": contentType, "Cache-Control": "no-store", "Content-Disposition": `${disposition}; filename="${r.filename}"`, "X-Content-Type-Options": "nosniff" },
    });
  });
}
