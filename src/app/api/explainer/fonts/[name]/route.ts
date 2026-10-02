import fs from "node:fs";
import path from "node:path";
import { FONT } from "@/lib/explainer/design";
import { FONT_DIR } from "@/lib/explainer/measure";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ name: string }> };

/** GET /api/explainer/fonts/:name  The explainer faces, so the interactive player draws with the fonts the layout was measured with. */
export async function GET(_req: Request, { params }: Ctx) {
  const { name } = await params;
  if (!Object.values(FONT.files).includes(name as never)) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(path.join(FONT_DIR, name))), { headers: { "Content-Type": "font/ttf", "Cache-Control": "public, max-age=604800, immutable" } });
}
