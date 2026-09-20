import { getReadyProject, guard, json } from "@/lib/api";
import { changeImpact, impactMermaid } from "@/lib/map";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    const u = new URL(req.url);
    const type = u.searchParams.get("type");
    const target = u.searchParams.get("id");
    if ((type !== "file" && type !== "symbol") || !target) throw new AppError("invalid_request", "Provide type=file|symbol and an id (a file path or id, or a symbol id).", 400);
    const impact = changeImpact(id, { type, id: target });
    if (!impact) throw new AppError("target_not_found", "That file or symbol was not found.", 404);
    return json({ impact, mermaid: impactMermaid(impact) });
  });
}
