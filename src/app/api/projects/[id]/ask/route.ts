import { z } from "zod";
import { askRepository, recentQuestions } from "@/lib/ask";
import { getReadyProject, guard, json } from "@/lib/api";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ question: z.string().min(3).max(1000) });

export async function GET(_req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    return json({ history: recentQuestions(id).map((q) => ({ id: q.id, question: q.question, answer: q.answer, createdAt: q.createdAt })) });
  });
}

export async function POST(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    getReadyProject(id);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Ask a question of at least a few words (up to 1000 characters).", 400);
    return json({ answer: await askRepository(id, parsed.data.question) });
  });
}
