import type { FileRow } from "../db/schema";

/**
 * Resolve an import specifier to a repository file path. Returns undefined
 * when the import refers to an external package or cannot be located.
 */
export function resolveImport(fromPath: string, specifier: string, language: string, pathSet: Set<string>, aliases: Record<string, string> = {}): string | undefined {
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const tryPaths = (base: string, exts: string[]): string | undefined => {
    const clean = base.replace(/\/+$/, "");
    if (pathSet.has(clean)) return clean;
    for (const e of exts) if (pathSet.has(clean + e)) return clean + e;
    for (const e of exts) if (pathSet.has(`${clean}/index${e}`)) return `${clean}/index${e}`;
    return undefined;
  };
  const joinRel = (dir: string, rel: string): string => {
    const parts = dir ? dir.split("/") : [];
    for (const seg of rel.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return parts.join("/");
  };

  switch (language) {
    case "TypeScript": case "JavaScript": case "Vue": case "Svelte": case "CSS": case "SCSS": case "HTML": case "Markdown": {
      const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".json", ".css", ".scss", ".d.ts"];
      const stripped = specifier.replace(/\.js$/, "").replace(/\?.*$/, "");
      if (specifier.startsWith(".")) return tryPaths(joinRel(fromDir, stripped), exts) ?? tryPaths(joinRel(fromDir, specifier), exts);
      if (specifier.startsWith("/")) return tryPaths(specifier.slice(1), exts);
      for (const [alias, target] of Object.entries(aliases)) {
        const prefix = alias.replace(/\*$/, "");
        if (specifier.startsWith(prefix)) {
          const rest = specifier.slice(prefix.length);
          const base = target.replace(/\*$/, "").replace(/^\.\//, "").replace(/\/$/, "");
          const cand = tryPaths(joinRel("", base + (rest ? "/" + rest : "")).replace(/\/+/g, "/"), exts);
          if (cand) return cand;
        }
      }
      // Common conventions: @/x -> src/x, ~/x -> src/x
      if (/^[@~]\//.test(specifier)) {
        const rest = specifier.slice(2);
        return tryPaths(`src/${rest}`, exts) ?? tryPaths(rest, exts) ?? tryPaths(`app/${rest}`, exts);
      }
      return undefined;
    }
    case "Python": {
      if (specifier.startsWith(".")) {
        const dots = specifier.match(/^\.+/)![0].length;
        const rest = specifier.slice(dots).replace(/\./g, "/");
        let dir = fromDir;
        for (let i = 1; i < dots; i++) dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
        const base = rest ? `${dir ? dir + "/" : ""}${rest}` : dir;
        return tryPaths(base, [".py"]) ?? tryPaths(`${base}/__init__`, [".py"]);
      }
      const rel = specifier.replace(/\./g, "/");
      const roots = ["", "src/", "app/", "lib/", fromDir ? fromDir + "/" : ""];
      for (const r of roots) {
        const hit = tryPaths(r + rel, [".py"]) ?? tryPaths(`${r}${rel}/__init__`, [".py"]);
        if (hit) return hit;
      }
      // Partial: first segment may be a package directory at the root.
      const first = rel.split("/")[0];
      for (const r of roots) {
        const hit = tryPaths(`${r}${first}/__init__`, [".py"]) ?? tryPaths(r + first, [".py"]);
        if (hit) return hit;
      }
      return undefined;
    }
    case "Go": {
      // Match module path suffix against directories in the repo.
      const segs = specifier.split("/");
      for (let i = 0; i < segs.length; i++) {
        const dir = segs.slice(i).join("/");
        const hit = [...pathSet].find((p) => p.endsWith(".go") && (p.slice(0, p.lastIndexOf("/")) === dir || (dir === "" && !p.includes("/"))));
        if (hit) return hit;
      }
      return undefined;
    }
    case "Java": case "Kotlin": case "Scala": {
      const rel = specifier.replace(/\.\*$/, "").replace(/\./g, "/");
      const hit = [...pathSet].find((p) => /\.(java|kt|scala)$/.test(p) && (p.endsWith(`/${rel}.java`) || p.endsWith(`/${rel}.kt`) || p.endsWith(`/${rel}.scala`) || p === `${rel}.java`));
      return hit;
    }
    case "C#": {
      // Namespaces map loosely to directories; match a file declaring the namespace by directory name.
      const last = specifier.split(".").pop() ?? specifier;
      return [...pathSet].find((p) => p.endsWith(".cs") && p.split("/").slice(0, -1).includes(last));
    }
    case "Ruby": {
      if (specifier.startsWith(".") || specifier.startsWith("/")) return tryPaths(joinRel(fromDir, specifier), [".rb"]);
      return tryPaths(specifier, [".rb"]) ?? tryPaths(`lib/${specifier}`, [".rb"]) ?? tryPaths(`app/${specifier}`, [".rb"]) ?? tryPaths(joinRel(fromDir, specifier), [".rb"]);
    }
    case "Rust": {
      if (specifier === "crate" || specifier === "self" || specifier === "super") return undefined;
      return tryPaths(`src/${specifier}`, [".rs"]) ?? tryPaths(`src/${specifier}/mod`, [".rs"]) ?? tryPaths(joinRel(fromDir, specifier), [".rs"]);
    }
    case "PHP": {
      const rel = specifier.replace(/\\/g, "/");
      const parts = rel.split("/");
      for (let i = 0; i < parts.length; i++) {
        const hit = tryPaths(parts.slice(i).join("/"), [".php"]) ?? tryPaths("src/" + parts.slice(i).join("/"), [".php"]) ?? tryPaths("app/" + parts.slice(i).join("/"), [".php"]);
        if (hit) return hit;
      }
      if (specifier.startsWith(".")) return tryPaths(joinRel(fromDir, specifier), [".php"]);
      return undefined;
    }
    case "Shell": return tryPaths(joinRel(fromDir, specifier), [".sh", ""]);
    default: {
      if (specifier.startsWith(".")) return tryPaths(joinRel(fromDir, specifier), ["", ".h", ".hpp", ".c", ".cpp", ".kt", ".swift", ".dart"]);
      return tryPaths(specifier, ["", ".h", ".hpp"]) ?? tryPaths(`include/${specifier}`, [""]) ?? tryPaths(`src/${specifier}`, [""]);
    }
  }
}

/** Read TS path aliases from tsconfig/jsconfig if present. */
export function readPathAliases(filesByPath: Map<string, FileRow & { text?: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["tsconfig.json", "jsconfig.json", "tsconfig.base.json"]) {
    const f = filesByPath.get(name);
    if (!f?.text) continue;
    try {
      const json = JSON.parse(f.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"));
      const baseUrl: string = json.compilerOptions?.baseUrl ?? ".";
      const paths: Record<string, string[]> = json.compilerOptions?.paths ?? {};
      for (const [k, v] of Object.entries(paths)) {
        const target = v[0];
        if (target) out[k] = (baseUrl === "." ? "" : baseUrl.replace(/^\.\//, "") + "/") + target.replace(/^\.\//, "");
      }
    } catch {
      // ignore malformed tsconfig
    }
  }
  return out;
}

/** Classify an import specifier as an external package name, or undefined for relative imports. */
export function externalPackageName(specifier: string, language: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || /^[@~]\//.test(specifier)) return undefined;
  switch (language) {
    case "TypeScript": case "JavaScript": case "Vue": case "Svelte": {
      if (specifier.startsWith("node:")) return undefined;
      const builtins = new Set(["fs", "path", "os", "http", "https", "crypto", "url", "util", "stream", "events", "child_process", "buffer", "zlib", "net", "tls", "dns", "assert", "readline", "worker_threads", "cluster", "process", "querystring", "string_decoder", "timers", "tty", "dgram", "v8", "vm", "perf_hooks", "async_hooks", "module"]);
      if (builtins.has(specifier)) return undefined;
      const parts = specifier.split("/");
      return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    }
    case "Python": return specifier.split(".")[0];
    case "Go": return specifier.includes(".") ? specifier.split("/").slice(0, 3).join("/") : undefined;
    case "Java": case "Kotlin": return specifier.split(".").slice(0, 3).join(".");
    case "C#": return specifier.split(".").slice(0, 2).join(".");
    case "Ruby": return specifier;
    case "Rust": return specifier === "std" || specifier === "core" ? undefined : specifier;
    case "PHP": return specifier.split("\\")[0];
    default: return specifier;
  }
}
