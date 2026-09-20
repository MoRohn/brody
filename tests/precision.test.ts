import { describe, expect, it } from "vitest";
import { blankLiterals, scanText } from "@/lib/analysis/rules";
import type { Architecture } from "@/lib/discover/types";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { analyze, freshDb, fromStrings } from "./helpers";

const ids = (lang: string, text: string, path = "src/x.ts") => scanText(path, lang, text, false).map((f) => f.analyzer!.replace("brody-rules/", ""));
const arch = (r: { project: { analysis: unknown } }) => (r.project.analysis as { architecture: Architecture }).architecture;

describe("rule precision: code, not strings, comments, regexes or tests", () => {
  it("blanks literal contents and trailing comments", () => {
    expect(blankLiterals('const a = "eval(x)"; // eval(y)')).toBe('const a = ""; ');
    expect(blankLiterals("const r = /eval\\(x\\)/g.test(s);")).toBe("const r = /re/.test(s);");
    expect(blankLiterals("const u = 'http://a.b'; f(x / 2, y / 3);")).toContain("f(x / 2, y / 3)");
    expect(blankLiterals("`text eval(x) ${dir} more`")).toBe("`${dir}`");
  });
  it("does not flag eval that only appears in strings, regexes or comments", () => {
    expect(ids("TypeScript", 'const title = "Dynamic code evaluation with eval()";')).not.toContain("eval");
    expect(ids("TypeScript", "const re = /(?<![.\\w])eval\\s*\\(/;")).not.toContain("eval");
    expect(ids("TypeScript", "run(); // never call eval(x) here")).not.toContain("eval");
    expect(ids("TypeScript", "const v = eval(userInput);")).toContain("eval");
  });
  it("distinguishes RegExp.exec from shell exec", () => {
    expect(ids("TypeScript", "const m = re.exec(line);")).not.toContain("child-process-exec");
    expect(ids("TypeScript", "const m = /a/.exec(text);")).not.toContain("child-process-exec");
    expect(ids("TypeScript", "child_process.exec(`rm -rf ${dir}`);")).toContain("child-process-exec");
    expect(ids("TypeScript", "exec(`ls ${dir}`);")).toContain("child-process-exec");
  });
  it("honours brody-ignore on the line or the line above, by rule id", () => {
    expect(ids("TypeScript", "const v = eval(x); // brody-ignore")).toEqual([]);
    expect(ids("TypeScript", "// brody-ignore: eval  (sandboxed)\nconst v = eval(x);")).toEqual([]);
    expect(ids("TypeScript", "// brody-ignore: sync-io\nconst v = eval(x);")).toContain("eval");
  });
  it("skips test files and reports repetitive rules once per file", () => {
    expect(scanText("tests/a.test.ts", "TypeScript", "eval(x);", true)).toEqual([]);
    const many = scanText("src/a.ts", "TypeScript", "console.log(1);\nconsole.log(2);\nconsole.log(3);\n", false).filter((f) => f.analyzer === "brody-rules/console-log");
    expect(many).toHaveLength(1);
    expect(many[0].whatHappens).toContain("2 more occurrences");
    expect(ids("TypeScript", "console.log(1);", "scripts/run.mts")).not.toContain("console-log");
  });
  it("treats an empty catch that carries a comment as deliberate", () => {
    expect(ids("TypeScript", "try { a(); } catch {\n  // ignore: optional\n}\n")).not.toContain("empty-catch");
    expect(ids("TypeScript", "try { a(); } catch {\n}\n")).toContain("empty-catch");
  });
});

describe("architecture precision", () => {
  it("does not mistake an error-wrapper named guard() for authentication, and does see real auth", async () => {
    freshDb();
    const r = await analyze(fromStrings({
      "package.json": JSON.stringify({ dependencies: { next: "16" } }),
      "app/api/a/route.ts": 'export async function GET() { return guard(async () => Response.json({})); }\n',
      "app/api/b/route.ts": 'export async function GET() { const session = await getServerSession(); return Response.json({ session }); }\n',
      "app/api/c/route.ts": 'export async function GET() { return Response.json({}); }\n',
      "app/api/d/route.ts": 'export async function GET() { return Response.json({}); }\n',
    }));
    const routes = Object.fromEntries(arch(r).routes.map((x) => [x.path, x.auth]));
    expect(routes["/api/a"]).toBe("unknown");
    expect(routes["/api/b"]).toBe("authenticated");
    const titles = getDb().select().from(schema.findings).where(eq(schema.findings.projectId, r.projectId)).all().map((f) => f.title);
    expect(titles.some((t) => t.includes("API routes show no authentication check while 1 other"))).toBe(true);
  });

  it("flags a service whose routes have no authentication at all", async () => {
    freshDb();
    const r = await analyze(fromStrings({
      "package.json": JSON.stringify({ dependencies: { express: "4" } }),
      "server.js": 'const app = require("express")();\napp.get("/a", (req, res) => res.send(1));\napp.get("/b", (req, res) => res.send(2));\napp.post("/c", (req, res) => res.send(3));\napp.listen(3000);\n',
    }));
    expect(getDb().select().from(schema.findings).where(eq(schema.findings.projectId, r.projectId)).all().some((f) => f.title.startsWith("None of the 3 API routes"))).toBe(true);
  });

  it("ignores manifests, models, env and services that live in fixtures and test data", async () => {
    freshDb();
    const r = await analyze(fromStrings({
      "package.json": JSON.stringify({ name: "real", dependencies: { express: "4" } }),
      "src/app.js": 'const e = require("express");\nmodule.exports = e();\n',
      "fixtures/demo/package.json": JSON.stringify({ dependencies: { stripe: "1", pg: "8" } }),
      "fixtures/demo/src/pay.js": 'const s = require("stripe");\nprocess.env.STRIPE_SECRET_KEY;\nmodule.exports = s;\n',
      "tests/data.test.ts": 'import x from "mongoose";\nexport const User = new x.Schema({ a: String });\n',
    }));
    const a = arch(r);
    expect(a.externalServices.map((s) => s.name)).not.toContain("Stripe");
    expect(a.externalServices.map((s) => s.name)).not.toContain("PostgreSQL");
    expect(a.envVars.map((e) => e.name)).not.toContain("STRIPE_SECRET_KEY");
    expect(a.models).toHaveLength(0);
  });

  it("names functional areas after modules under lib/ instead of one giant utilities bucket", async () => {
    freshDb();
    const f = (n: string) => `export function ${n}() { return 1; }\n`;
    const r = await analyze(fromStrings({
      "src/lib/parse/a.ts": f("a"), "src/lib/parse/b.ts": f("b"), "src/lib/billing/x.ts": f("x"), "src/lib/util/y.ts": f("y"), "src/lib/misc.ts": f("m"),
    }));
    const names = arch(r).areas.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["Parse", "Payments & Billing", "Util", "Shared Utilities"]));
  });

  it("does not report setInterval in a component or service as a scheduled entry point", async () => {
    freshDb();
    const r = await analyze(fromStrings({
      "src/components/clock.tsx": 'export function Clock() { setInterval(() => 1, 1000); return null; }\n',
      "src/lib/jobs/worker.ts": 'export function start() { setInterval(() => 1, 1000); }\n',
    }));
    const eps = arch(r).entryPoints.map((e) => `${e.path}:${e.kind}`);
    expect(eps.some((e) => e.startsWith("src/components/clock.tsx"))).toBe(false);
    expect(eps).toContain("src/lib/jobs/worker.ts:worker");
  });
});
