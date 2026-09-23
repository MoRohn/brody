import { getReadyProject, guard, json } from "@/lib/api";
import type { FormalReport } from "@/lib/formal/types";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** The Lean 4 formal verification report: every modelled function, its theorems, their outcomes and the checked source. */
export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const p = getReadyProject(id);
    const formal = ((p.analysis ?? {}) as { formal?: FormalReport }).formal ?? null;
    return json({ formal });
  });
}
