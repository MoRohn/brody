import { and, asc, count, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { getReadyProject, guard, intParam, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const SEV = ["Critical", "High", "Medium", "Low", "Informational"];
const F = schema.findings;

/** A user's search text as a literal for LIKE: % and _ carry no meaning of their own. */
const likeLiteral = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    const u = new URL(req.url);
    const q = (u.searchParams.get("q") ?? "").toLowerCase().trim();
    const list = (k: string) => (u.searchParams.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const sev = list("severity"), cat = list("category"), origin = list("origin"), ver = list("verification"), area = list("area"), conf = list("confidence");
    const file = u.searchParams.get("file");
    const db = getDb();

    // Facets count the whole project, unfiltered, as before; the database does the counting instead of the request loading every row.
    const live = and(eq(F.projectId, id), ne(F.verification, "rejected"));
    const facet = (col: typeof F.severity | typeof F.category | typeof F.origin | typeof F.verification | typeof F.area | typeof F.confidence) => {
      const out: Record<string, number> = {};
      for (const r of db.select({ v: col, n: count() }).from(F).where(live).groupBy(col).all()) if (r.v) out[r.v] = r.n;
      return out;
    };
    const facetData = { severity: facet(F.severity), category: facet(F.category), origin: facet(F.origin), verification: facet(F.verification), area: facet(F.area), confidence: facet(F.confidence) };

    const where: (SQL | undefined)[] = [live];
    if (sev.length) where.push(inArray(F.severity, sev));
    if (cat.length) where.push(inArray(F.category, cat));
    if (origin.length) where.push(inArray(F.origin, origin));
    if (ver.length) where.push(inArray(F.verification, ver));
    if (area.length) where.push(inArray(F.area, area));
    if (conf.length) where.push(inArray(F.confidence, conf));
    if (file) where.push(eq(F.filePath, file));
    // The search text is bound as a parameter, never spliced into the statement.
    if (q) where.push(sql`lower(${F.code} || ' ' || ${F.title} || ' ' || coalesce(${F.filePath}, '') || ' ' || ${F.whatHappens} || ' ' || ${F.category}) like ${likeLiteral(q)} escape '\\'`);
    const filtered = and(...where);

    const limit = intParam(u.searchParams.get("limit"), 200, 1, 1000);
    const offset = intParam(u.searchParams.get("offset"), 0, 0, 100000);
    const total = db.select({ n: count() }).from(F).where(filtered).get()?.n ?? 0;
    const severityRank = sql`case ${F.severity} ${sql.join(SEV.map((s, i) => sql`when ${s} then ${i}`), sql` `)} else -1 end`;
    const rows = db.select().from(F).where(filtered).orderBy(severityRank, asc(F.code)).limit(limit).offset(offset).all();
    return json({ total, facets: facetData, findings: rows.map(({ projectId: _p, ...f }) => f) });
  });
}
