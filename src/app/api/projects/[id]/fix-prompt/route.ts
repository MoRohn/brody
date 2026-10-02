import { getReadyProject, guard, json } from "@/lib/api";
import { buildFixPrompt } from "@/lib/review/fixprompt";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/:id/fix-prompt?severity=High,Critical&category=…&origin=…&area=…&q=…&unverified=0&patches=0&evidence=0
 * Every open issue from the review, condensed and ordered, with fixes, as a ready-to-paste AI prompt in Markdown.
 * JSON by default ({ markdown, fileName, stats, issues }); ?download=1 returns the .md file as an attachment.
 */
export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    const u = new URL(req.url);
    const list = (k: string) => (u.searchParams.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const off = (k: string) => u.searchParams.get(k) === "0";
    const p = buildFixPrompt(id, { severities: list("severity"), categories: list("category"), origins: list("origin"), areas: list("area"), q: u.searchParams.get("q") ?? undefined, includeUnverified: !off("unverified"), includePatches: !off("patches"), includeEvidence: !off("evidence") });
    if (u.searchParams.get("download") === "1") {
      return new Response(p.markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${p.fileName}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    return json({ markdown: p.markdown, fileName: p.fileName, stats: p.stats, issues: p.issues.map((i) => ({ n: i.n, title: i.title, severity: i.severity, category: i.category, codes: i.codes, locations: i.locations, verified: i.verified, fix: i.findings[0].remediation, patch: i.findings.some((f) => !!f.patch) })) });
  });
}
