import { guard, json } from "@/lib/api";
import { canInstallLean, leanInstallState, startLeanInstall } from "@/lib/formal/install";
import { AppError } from "@/lib/util/errors";

export const dynamic = "force-dynamic";

/** Install state of Add Lean. */
export async function GET() {
  return guard(() => json({ install: leanInstallState() }));
}

/**
 * Add Lean: start installing the pinned Lean toolchain in the background. Only accepted from Brody's own pages:
 * the JSON content type forces a CORS preflight, and cross-site browser requests are refused outright.
 */
export async function POST(req: Request) {
  return guard(() => {
    const site = req.headers.get("sec-fetch-site");
    if ((site && site !== "same-origin" && site !== "none") || !(req.headers.get("content-type") ?? "").includes("application/json")) {
      throw new AppError("forbidden", "Add Lean can only be started from Brody itself.", 403);
    }
    const can = canInstallLean();
    if (!can.ok) throw new AppError("lean_install_unavailable", "Lean cannot be installed from here.", 400, can.reason);
    return json({ install: startLeanInstall() }, 202);
  });
}
