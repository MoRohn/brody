/**
 * Bundle the parse worker into dist/parse-worker.cjs.
 *
 * The analysis runs inside the Next.js server, whose production image ships only .next and node_modules, so the worker
 * thread needs a compiled entry point of its own. Everything that must load from node_modules at runtime (native or WASM
 * packages and the analyzers) stays external, exactly as in next.config.ts.
 *
 *   node tools/build-worker.mjs
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildWorker(outfile = path.join(root, "dist", "parse-worker.cjs")) {
  await build({
    entryPoints: [path.join(root, "src", "lib", "parse", "worker.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["web-tree-sitter", "typescript", "eslint", "@typescript-eslint/parser"],
    logLevel: "warning",
    legalComments: "none",
  });
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildWorker();
  console.log(`parse worker built: ${path.relative(root, out)}`);
}
