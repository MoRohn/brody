import { getReadyProject, guard, json } from "@/lib/api";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import type { Architecture } from "@/lib/discover/types";
import { buildBrief } from "@/lib/docs/brief";
import type { DocReport } from "@/lib/docs/types";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Generated documentation as structured JSON (section, area, file and symbol level). */
export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const p = getReadyProject(id);
    const analysis = (p.analysis ?? {}) as { docs?: DocReport; architecture?: Architecture };
    const docs = analysis.docs ? { ...analysis.docs } : undefined;
    if (!docs) return json({ docs: null });
    if (!docs.brief && analysis.architecture) {
      const findings = getDb().select().from(schema.findings).where(and(eq(schema.findings.projectId, id))).all().filter((f) => f.verification !== "rejected");
      docs.brief = buildBrief(docs, analysis.architecture, findings, p.name);
    }
    const u = new URL(req.url);
    if (u.searchParams.get("lite") === "1") { const { files: _f, symbols: _s, ...rest } = docs; return json({ docs: { ...rest, files: docs.files.map((f) => ({ path: f.path, area: f.area, role: f.role, origin: f.origin })), symbols: docs.symbols.length } }); }
    return json({ docs });
  });
}
