import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional host allow-list. When ALLOWED_HOSTS is set (comma separated hostnames, no port),
 * requests addressed to any other hostname, including localhost, are refused. This pins the
 * app to its intended address (http://brody:3003) and blocks DNS-rebinding style access.
 */
export function proxy(request: NextRequest) {
  const allowed = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return NextResponse.next();
  const host = (request.headers.get("host") ?? "").split(":")[0].toLowerCase();
  if (allowed.includes(host)) return NextResponse.next();
  const port = process.env.PORT ?? "3003";
  return new NextResponse(`This app is served only at http://${allowed[0]}:${port}\n`, { status: 421, headers: { "content-type": "text/plain; charset=utf-8" } });
}
