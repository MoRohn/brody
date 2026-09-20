import { getReadyProject, guard, intParam, json } from "@/lib/api";
import { search, type HitKind } from "@/lib/retrieval";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const KINDS = new Set(["file", "symbol", "finding", "doc", "code"]);

export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    const u = new URL(req.url);
    const q = (u.searchParams.get("q") ?? "").trim();
    if (!q) return json({ hits: [], query: q });
    const kinds = (u.searchParams.get("kinds") ?? "").split(",").filter((k) => KINDS.has(k)) as HitKind[];
    const hits = await search(id, q, {
      kinds: kinds.length ? kinds : undefined, language: u.searchParams.get("language") ?? undefined, extension: u.searchParams.get("extension") ?? undefined, symbolKind: u.searchParams.get("symbolKind") ?? undefined,
      severity: u.searchParams.get("severity") ?? undefined, category: u.searchParams.get("category") ?? undefined, area: u.searchParams.get("area") ?? undefined, limit: intParam(u.searchParams.get("limit"), 40, 1, 200), includeCode: !kinds.length || kinds.includes("code"),
    });
    return json({ query: q, hits });
  });
}
