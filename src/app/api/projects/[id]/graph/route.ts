import { getReadyProject, guard, intParam, json } from "@/lib/api";
import { areaGraph, graphToMermaid, moduleGraph, symbolGraph } from "@/lib/map";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** type=area (high level) | module (files, optionally filtered by area or directory) | symbol (neighbourhood). */
export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    const u = new URL(req.url);
    const type = u.searchParams.get("type") ?? "area";
    let g;
    if (type === "area") g = areaGraph(id);
    else if (type === "module") g = moduleGraph(id, { area: u.searchParams.get("area") ?? undefined, directory: u.searchParams.get("dir") ?? undefined, limit: intParam(u.searchParams.get("limit"), 60, 5, 200) });
    else if (type === "symbol") {
      const s = u.searchParams.get("symbol");
      if (!s) throw new AppError("invalid_request", "Provide a symbol id.", 400);
      g = symbolGraph(id, s, intParam(u.searchParams.get("depth"), 1, 1, 3));
    } else throw new AppError("invalid_request", `Unknown graph type "${type}".`, 400, "Use area, module or symbol.");
    return json({ graph: g, mermaid: u.searchParams.get("mermaid") === "1" ? graphToMermaid(g) : undefined });
  });
}
