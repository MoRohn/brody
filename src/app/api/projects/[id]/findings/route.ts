import { } from "drizzle-orm";
import { getReadyProject, guard, intParam, json } from "@/lib/api";
import { schema, projectRows } from "@/lib/db/client";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const SEV = ["Critical", "High", "Medium", "Low", "Informational"];

export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    const u = new URL(req.url);
    const q = (u.searchParams.get("q") ?? "").toLowerCase().trim();
    const list = (k: string) => (u.searchParams.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const sev = list("severity"), cat = list("category"), origin = list("origin"), ver = list("verification"), area = list("area"), conf = list("confidence");
    const file = u.searchParams.get("file");
    let rows = projectRows(schema.findings, id).filter((f) => f.verification !== "rejected");
    const facets = (k: (f: (typeof rows)[number]) => string | null) => { const m: Record<string, number> = {}; for (const f of rows) { const v = k(f); if (v) m[v] = (m[v] ?? 0) + 1; } return m; };
    const facetData = { severity: facets((f) => f.severity), category: facets((f) => f.category), origin: facets((f) => f.origin), verification: facets((f) => f.verification), area: facets((f) => f.area), confidence: facets((f) => f.confidence) };
    rows = rows.filter((f) => (!sev.length || sev.includes(f.severity)) && (!cat.length || cat.includes(f.category)) && (!origin.length || origin.includes(f.origin)) && (!ver.length || ver.includes(f.verification)) && (!area.length || (f.area && area.includes(f.area))) && (!conf.length || conf.includes(f.confidence)) && (!file || f.filePath === file) && (!q || `${f.code} ${f.title} ${f.filePath ?? ""} ${f.whatHappens} ${f.category}`.toLowerCase().includes(q)));
    rows.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || a.code.localeCompare(b.code));
    const limit = intParam(u.searchParams.get("limit"), 200, 1, 1000);
    const offset = intParam(u.searchParams.get("offset"), 0, 0, 100000);
    return json({ total: rows.length, facets: facetData, findings: rows.slice(offset, offset + limit).map(({ projectId: _p, ...f }) => f) });
  });
}
