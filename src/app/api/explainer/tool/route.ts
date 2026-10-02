import { z } from "zod";
import { guard, json } from "@/lib/api";
import { jsonBody } from "@/lib/explainer/http";
import { invokeTool, TOOLS } from "@/lib/explainer/tool";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** GET /api/explainer/tool  The tool definitions (JSON Schema), for agents that call Brody over HTTP. */
export async function GET() {
  return guard(() => json({ tools: TOOLS }));
}

/** POST /api/explainer/tool  { name, arguments }  Invoke an explainer tool. */
export async function POST(req: Request) {
  return guard(async () => {
    const body = await jsonBody(req, z.object({ name: z.string().max(60), arguments: z.record(z.string(), z.unknown()).default({}) }), 'Send { "name": "create_explainer", "arguments": { ... } }.');
    return json({ result: await invokeTool(body.name, body.arguments) });
  });
}
