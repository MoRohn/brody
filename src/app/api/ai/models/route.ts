import { guard, json } from "@/lib/api";
import { listModels } from "@/lib/ai/models";
import { PROVIDER_IDS } from "@/lib/ai/settings";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";

/** GET /api/ai/models?provider=anthropic|openai-compatible[&refresh=1]. Lists the models the provider offers; refresh bypasses the cache. */
export async function GET(req: Request) {
  return guard(async () => {
    const url = new URL(req.url);
    const provider = url.searchParams.get("provider");
    if (!PROVIDER_IDS.includes(provider as (typeof PROVIDER_IDS)[number])) throw new AppError("invalid_provider", "Choose a provider: anthropic or openai-compatible.", 400);
    const refresh = ["1", "true"].includes(url.searchParams.get("refresh") ?? "");
    return json(await listModels(provider as (typeof PROVIDER_IDS)[number], { refresh }));
  });
}
