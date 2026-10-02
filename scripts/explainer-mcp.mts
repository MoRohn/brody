/**
 * Brody explainer MCP server (stdio).
 *
 *   npm run explainer:mcp            # talks to Brody at BRODY_URL (default http://localhost:3003)
 *
 * Exposes the explainer tools (create_explainer, get_video_job, refine_explainer, regenerate_section) to any MCP client.
 * It holds no state of its own: every call goes to a running Brody's POST /api/explainer/tool, so the MCP client, the
 * web UI and HTTP agents share one database, one job worker and one set of contracts (src/lib/explainer/tool.ts).
 *
 * Claude Code:  claude mcp add brody-explainer -- npm --prefix /path/to/brody run -s explainer:mcp
 */
import readline from "node:readline";

const BASE = (process.env.BRODY_URL ?? "http://localhost:3003").replace(/\/$/, "");
const PROTOCOL = "2025-06-18";

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const log = (s: string) => process.stderr.write(`[brody-explainer-mcp] ${s}\n`);

async function brody(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const err = (body.error ?? {}) as { message?: string; hint?: string };
    throw new Error(`${err.message ?? `Brody returned HTTP ${res.status}`}${err.hint ? ` ${err.hint}` : ""}`);
  }
  return body;
}

async function handle(msg: { id?: number | string; method: string; params?: Json }) {
  switch (msg.method) {
    case "initialize":
      return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "brody-explainer", version: "1.0.0" }, instructions: "Turn a grounded Brody result (an Ask answer, a file, area or system explanation, a finding) into clear text, a diagram, an interactive explainer or a narrated video. Pass the result's sourceRunId, never its text." };
    case "tools/list": {
      const { tools } = (await brody("/api/explainer/tool")) as { tools: { name: string; description: string; parameters: Json }[] };
      return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
    }
    case "tools/call": {
      const p = msg.params as { name: string; arguments?: Json };
      try {
        const { result } = (await brody("/api/explainer/tool", { method: "POST", body: JSON.stringify({ name: p.name, arguments: p.arguments ?? {} }) })) as { result: Json };
        // Artifact links are made absolute so a client can open them.
        const text = JSON.stringify(result, null, 2).replace(/"\/(api|p)\//g, `"${BASE}/$1/`);
        return { content: [{ type: "text", text }], structuredContent: result };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    }
    case "ping":
      return {};
    default:
      if (msg.method.startsWith("notifications/")) return undefined;
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg: { id?: number | string; method: string; params?: Json };
  try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); return; }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ id: msg.id, error: { code: (e as { code?: number }).code ?? -32603, message: (e as Error).message } });
  }
});
log(`ready; Brody at ${BASE}`);
