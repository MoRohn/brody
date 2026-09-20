import { z } from "zod";
import { getReadyProject, guard, json } from "@/lib/api";
import { explainAIError, getAIProvider, UsageMeter } from "@/lib/ai";
import type { Architecture } from "@/lib/discover/types";
import { narrateModule } from "@/lib/docs/ai";
import { getExplain, MODULE_CACHED_FIELDS, moduleExplainKey, pick, putExplain } from "@/lib/docs/cache";
import { loadDocInputs } from "@/lib/docs";
import { explainCollection } from "@/lib/docs/modules";
import type { DocReport, ModuleDoc } from "@/lib/docs/types";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

function context(id: string) {
  const p = getReadyProject(id);
  const analysis = (p.analysis ?? {}) as { architecture?: Architecture; docs?: DocReport };
  if (!analysis.architecture || !analysis.docs) throw new AppError("no_documentation", "This project has no generated documentation yet.", 409, "Re-run the analysis, then try again.");
  return { arch: analysis.architecture, docs: analysis.docs };
}

/**
 * GET /api/projects/:id/explain?path=src/services
 * The macro explanation of a folder: how its files work together. Uses the stored explanation when the analysis
 * produced one, otherwise computes it from the dependency graph (so any folder works, including in older projects).
 */
export async function GET(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    const path = (new URL(req.url).searchParams.get("path") ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!path) throw new AppError("invalid_request", "Give a folder path, for example ?path=src/services.", 400);
    const { arch, docs } = context(id);
    const stored = (docs.modules ?? []).find((m) => m.path === path);
    if (stored) return json({ collection: stored, source: "stored" });
    const collection = explainCollection(loadDocInputs(id, arch), docs.files, [path]);
    if (!collection) throw new AppError("not_found", `No source files were found under "${path}".`, 404, "Choose a folder that contains code, or open the Files view to browse the repository.");
    return json({ collection, source: "computed" });
  });
}

const BodySchema = z.object({ paths: z.array(z.string().trim().min(1).max(500)).min(1).max(200), ai: z.boolean().optional() });

/**
 * POST /api/projects/:id/explain   { paths: string[], ai?: boolean }
 * Explain any group of files and folders together. The structural explanation is always returned; with ai: true and
 * a configured provider, the narrative is written by the model from the per-file summaries (one call, cached).
 */
export async function POST(req: Request, { params }: Ctx) {
  return guard(async () => {
    const { id } = await params;
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new AppError("unsupported_media_type", "Send the selection as JSON.", 415);
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { \"paths\": [\"src/services\", \"src/utils/pricing.ts\"] } with 1 to 200 entries.", 400);
    const { arch, docs } = context(id);
    const inputs = loadDocInputs(id, arch);
    const collection = explainCollection(inputs, docs.files, parsed.data.paths);
    if (!collection) throw new AppError("not_found", "None of those paths matched source files in this project.", 404, "Use paths as they appear in the Files view, for example src/services or src/utils/pricing.ts.");
    const ai: { requested: boolean; available: boolean; used: boolean; error?: { summary: string; hint: string } } = { requested: !!parsed.data.ai, available: false, used: false };
    if (parsed.data.ai) {
      const provider = getAIProvider();
      ai.available = !!provider;
      if (provider) {
        const filesByPath = new Map(inputs.files.map((f) => [f.path, f]));
        const key = moduleExplainKey(provider.model, collection, filesByPath);
        const cached = getExplain<Record<string, unknown>>(key);
        if (cached) { Object.assign(collection, cached, { origin: "ai" }); ai.used = true; }
        else {
          const meter = new UsageMeter();
          const r = await narrateModule({ provider, meter, inputs, module: collection as ModuleDoc, fileDocs: new Map(docs.files.map((f) => [f.path, f])), filesByPath });
          if (r.ok) { putExplain(key, "module", pick(collection, MODULE_CACHED_FIELDS)); ai.used = true; }
          else if (meter.failures[0]) ai.error = explainAIError(meter.failures[0].error);
        }
      }
    }
    return json({ collection, source: "computed", ai });
  });
}
