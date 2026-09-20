import { getReadyProject, guard, json } from "@/lib/api";
import type { Architecture } from "@/lib/discover/types";
import { architectureDiagramText, architectureMermaid, erMermaid, legendText, NODE_LEGEND, EDGE_LEGEND, RISK_LEGEND } from "@/lib/map";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const p = getReadyProject(id);
    const arch = ((p.analysis ?? {}) as { architecture?: Architecture }).architecture;
    if (!arch) return json({ architecture: null });
    return json({
      architecture: { ...arch, secrets: arch.secrets.map((s) => ({ path: s.path, line: s.line, kind: s.kind })) },
      diagram: { text: architectureDiagramText(id), mermaid: architectureMermaid(id), er: erMermaid(id) },
      legend: { nodes: NODE_LEGEND, edges: EDGE_LEGEND, risk: RISK_LEGEND, text: legendText() },
    });
  });
}
