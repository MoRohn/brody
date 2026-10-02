import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fail } from "@/lib/api";
import { requireExplanation, resolveArtifact } from "@/lib/explainer/store";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; path: string[] }> };

const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".wav": "audio/wav", ".vtt": "text/vtt; charset=utf-8", ".srt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".py": "text/plain; charset=utf-8" };

/**
 * GET /api/explanations/:id/files/<path>  An artifact of the explanation, with HTTP range support so the player can seek.
 * ?download=1 sends it as an attachment.
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id, path: parts } = await params;
    const ex = requireExplanation(id);
    const file = resolveArtifact(id, parts.map(decodeURIComponent).join("/"));
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext];
    if (!type) return new Response("Not found", { status: 404 });
    const size = fs.statSync(file).size;
    const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" };
    if (new URL(req.url).searchParams.get("download")) {
      const name = `${ex.title.replace(/[^\w -]+/g, "").trim().slice(0, 60) || "explainer"}${path.basename(file) === "video.mp4" ? "" : ` - ${path.basename(file, ext)}`}${ext}`;
      headers["Content-Disposition"] = `attachment; filename="${name.replace(/"/g, "")}"`;
    }
    const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      end = Math.min(end, size - 1);
      start = Math.max(0, start);
      const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
      return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
  } catch (e) {
    return fail(e);
  }
}
