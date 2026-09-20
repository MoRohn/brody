import { and, eq } from "drizzle-orm";
import { getProject, guard, json, projectSummary } from "@/lib/api";
import { explainAIError, providerStatus } from "@/lib/ai";
import { getDb, schema } from "@/lib/db/client";
import type { Architecture } from "@/lib/discover/types";
import { buildBrief } from "@/lib/docs/brief";
import type { DocReport } from "@/lib/docs/types";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const project = getProject(id);
    const summary = projectSummary(project);
    if (project.status !== "ready") return json({ project: summary, ready: false });
    const analysis = (project.analysis ?? {}) as { architecture?: Architecture; docs?: DocReport; pipeline?: unknown; inventory?: unknown };
    const findings = getDb().select().from(schema.findings).where(and(eq(schema.findings.projectId, id))).all().filter((f) => f.verification !== "rejected");
    const count = (k: (f: (typeof findings)[number]) => string) => { const m: Record<string, number> = {}; for (const f of findings) m[k(f)] = (m[k(f)] ?? 0) + 1; return m; };
    const arch = analysis.architecture;
    const docs = analysis.docs;
    const top = findings.filter((f) => ["Critical", "High"].includes(f.severity)).sort((a, b) => (a.severity === b.severity ? a.code.localeCompare(b.code) : a.severity === "Critical" ? -1 : 1)).slice(0, 8).map((f) => ({ id: f.id, code: f.code, title: f.title, severity: f.severity, category: f.category, origin: f.origin, verification: f.verification, filePath: f.filePath, startLine: f.startLine }));
    return json({
      ready: true,
      project: summary,
      ai: providerStatus(),
      aiProblem: (() => { const f = ((analysis.pipeline ?? {}) as { aiFailures?: { task: string; error: string }[] }).aiFailures ?? []; return f.length ? { ...explainAIError(f[0].error), failures: f.length, first: f[0].error.slice(0, 240) } : null; })(),
      executiveSummary: docs?.executiveSummary ?? [],
      // Older projects have no brief; derive it so every project shows the business summary.
      brief: docs?.brief ?? (docs && arch ? buildBrief(docs, arch, findings, project.name) : null),
      atAGlance: docs?.atAGlance ?? [],
      architecture: arch ? { pattern: arch.pattern, applicationType: arch.applicationType, stack: arch.stack, stats: arch.stats, layers: arch.layers, entryPoints: arch.entryPoints.slice(0, 8), externalServices: arch.externalServices.map((s) => ({ name: s.name, category: s.category, purpose: s.purpose })) } : null,
      review: {
        total: findings.length,
        bySeverity: count((f) => f.severity), byCategory: count((f) => f.category), byOrigin: count((f) => f.origin), byVerification: count((f) => f.verification), top,
        testing: docs?.testing.paragraphs.map((p) => p.text) ?? [], security: docs?.securityModel.paragraphs.map((p) => p.text) ?? [], risks: docs?.risks.paragraphs.map((p) => p.text) ?? [],
      },
      pipeline: analysis.pipeline ?? null,
      inventory: analysis.inventory ?? null,
      docMeta: docs?.meta ?? null,
    });
  });
}
