import { and, eq } from "drizzle-orm";
import { getReadyProject, guard, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";
import type { DocReport } from "@/lib/docs/types";
import { getFileContent } from "@/lib/ingest/store";
import { changeImpact, symbolGraph, symbolNeighborhood } from "@/lib/map";
import { AppError } from "@/lib/util/errors";
import { sliceLines } from "@/lib/util/text";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; symbolId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id, symbolId } = await params;
    const project = getReadyProject(id);
    const n = symbolNeighborhood(id, symbolId);
    if (!n) throw new AppError("symbol_not_found", "That symbol does not exist in this project.", 404);
    const db = getDb();
    const file = db.select().from(schema.files).where(and(eq(schema.files.projectId, id), eq(schema.files.path, n.symbol.path))).get();
    const content = file ? getFileContent(file.hash) : undefined;
    const docs = ((project.analysis ?? {}) as { docs?: DocReport }).docs;
    const impact = changeImpact(id, { type: "symbol", id: symbolId });
    return json({ neighborhood: n, doc: docs?.symbols.find((s) => s.symbolId === symbolId) ?? null, code: content ? sliceLines(content, n.symbol.line, Math.min(n.symbol.endLine, n.symbol.line + 80)) : null, graph: symbolGraph(id, symbolId, 1), impact });
  });
}
