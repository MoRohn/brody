import { NextResponse, type NextRequest } from "next/server";

/** Loopback names always reach the app: a rebinding page cannot present them, and they need no /etc/hosts entry. */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
/**
 * Any name under .localhost is loopback too (RFC 6761): browsers and the operating system resolve it to this machine
 * without asking DNS, so no remote page can be served under it. This is what makes http://brody.localhost work with
 * no setup.
 */
const isLoopback = (host: string) => LOOPBACK.includes(host) || host.endsWith(".localhost");

/**
 * Host allow-list. ALLOWED_HOSTS is a comma separated list of hostnames (no port) and defaults to "brody";
 * set it empty to turn the check off. Requests addressed to any other hostname are refused, which blocks
 * DNS-rebinding style access. Loopback names are always accepted, so http://brody.localhost and
 * http://localhost:3003 work out of the box.
 */
export function proxy(request: NextRequest) {
  const allowed = (process.env.ALLOWED_HOSTS ?? "brody").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) return NextResponse.next();
  const hostHeader = (request.headers.get("host") ?? "").toLowerCase();
  const host = hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
  if (allowed.includes(host) || isLoopback(host)) return NextResponse.next();
  const port = process.env.PORT ?? "3003";
  return new NextResponse(`This app is served only at http://${allowed[0]}:${port}\n`, { status: 421, headers: { "content-type": "text/plain; charset=utf-8" } });
}
