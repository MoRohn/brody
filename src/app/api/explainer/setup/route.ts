import { z } from "zod";
import { guard, json } from "@/lib/api";
import { jsonBody } from "@/lib/explainer/http";
import { runExplainerSetup, toolSummary } from "@/lib/explainer/setup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/explainer/setup  FFmpeg, the Manim setup state and log, and whether setup runs automatically here. */
export async function GET() {
  return guard(async () => json(await toolSummary()));
}

/**
 * POST /api/explainer/setup  {}  Check now, and install Manim if it is missing (runs in the background; poll GET).
 * JSON only, like every state-changing explainer request, so another site cannot start an install.
 */
export async function POST(req: Request) {
  return guard(async () => {
    await jsonBody(req, z.object({}).passthrough(), "Send {} as JSON.");
    void runExplainerSetup("manual");
    await new Promise((r) => setTimeout(r, 50));
    return json(await toolSummary(), 202);
  });
}
