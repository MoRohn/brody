import { getReadyProject, guard, json } from "@/lib/api";
import { loadAssurance } from "@/lib/assurance";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** The security assessment and the privacy (PII) review, built from the same findings as the Code Review. */
export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    return json(loadAssurance(id));
  });
}
