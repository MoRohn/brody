import { z } from "zod";
import { guard, json } from "@/lib/api";
import { fetchGitHubMetadata, parseGitHubUrl } from "@/lib/ingest/github";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ url: z.string().min(1), ref: z.string().optional(), token: z.string().optional() });

export async function POST(req: Request) {
  return guard(async () => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Provide a GitHub repository URL.", 400, "Example: https://github.com/owner/repository");
    const ref = parseGitHubUrl(parsed.data.url);
    if (parsed.data.ref?.trim()) ref.ref = parsed.data.ref.trim();
    const meta = await fetchGitHubMetadata(ref, parsed.data.token?.trim() || undefined);
    return json({ metadata: meta });
  });
}
