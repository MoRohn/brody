import type { z } from "zod";
import { AppError } from "../util/errors";

/**
 * Parse a JSON request body against a schema. State-changing explainer requests must be JSON: a cross-site page cannot
 * send that content type without a CORS preflight the server never grants, so a hostile site cannot start jobs here.
 */
export async function jsonBody<T>(req: Request, schema: z.ZodType<T>, hint: string): Promise<T> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new AppError("unsupported_media_type", "Send the request body as JSON.", 415);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new AppError("invalid_request", `Invalid request: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}.`, 400, hint);
  return parsed.data;
}
