import { eq } from "drizzle-orm";
import { getReadyProject, guard, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";
import { repositoryTree, treeToText } from "@/lib/map";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const p = getReadyProject(id);
    const includeExcluded = new URL(req.url).searchParams.get("includeExcluded") === "1";
    const rows = getDb().select().from(schema.files).where(eq(schema.files.projectId, id)).all();
    const files = rows.filter((f) => includeExcluded || !f.isExcluded).map((f) => ({ id: f.id, path: f.path, name: f.name, language: f.language, size: f.size, lines: f.lines, classification: f.classification, role: f.role, area: f.area, isTest: f.isTest, isExcluded: f.isExcluded, excludeReason: f.excludeReason, isLarge: f.isLarge, isBinary: f.isBinary, isGenerated: f.isGenerated, duplicateOf: f.duplicateOf, parseStatus: f.parseStatus, importance: f.importance }));
    const excluded: Record<string, number> = {};
    for (const f of rows) if (f.isExcluded) excluded[f.excludeReason ?? "excluded"] = (excluded[f.excludeReason ?? "excluded"] ?? 0) + 1;
    return json({ files, tree: repositoryTree(id, { includeExcluded }), treeText: treeToText(repositoryTree(id, { includeExcluded }), { name: p.name, depth: 4 }), excluded });
  });
}
