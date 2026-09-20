import path from "node:path";
import fs from "node:fs";
import { Parser, Language, type Node, type Tree } from "web-tree-sitter";

/** Map of app language name -> grammar package + wasm file. */
const GRAMMARS: Record<string, { pkg: string; file: string }> = {
  TypeScript: { pkg: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  TSX: { pkg: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  JavaScript: { pkg: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
  Python: { pkg: "tree-sitter-python", file: "tree-sitter-python.wasm" },
  Go: { pkg: "tree-sitter-go", file: "tree-sitter-go.wasm" },
  Java: { pkg: "tree-sitter-java", file: "tree-sitter-java.wasm" },
  "C#": { pkg: "tree-sitter-c-sharp", file: "tree-sitter-c_sharp.wasm" },
  Ruby: { pkg: "tree-sitter-ruby", file: "tree-sitter-ruby.wasm" },
  Rust: { pkg: "tree-sitter-rust", file: "tree-sitter-rust.wasm" },
  PHP: { pkg: "tree-sitter-php", file: "tree-sitter-php.wasm" },
  CSS: { pkg: "tree-sitter-css", file: "tree-sitter-css.wasm" },
  HTML: { pkg: "tree-sitter-html", file: "tree-sitter-html.wasm" },
  JSON: { pkg: "tree-sitter-json", file: "tree-sitter-json.wasm" },
  Shell: { pkg: "tree-sitter-bash", file: "tree-sitter-bash.wasm" },
};

interface TsHolder {
  init?: Promise<void>;
  languages: Map<string, Promise<Language | null>>;
}
const holder: TsHolder = ((globalThis as unknown as { __brodyTs?: TsHolder }).__brodyTs ??= { languages: new Map() });

function grammarPath(pkg: string, file: string): string | undefined {
  const candidates = [
    path.join(process.cwd(), "node_modules", pkg, file),
    path.join(process.cwd(), "..", "node_modules", pkg, file),
  ];
  // brody-ignore: sync-io  (a handful of checks, once per grammar)
  return candidates.find((c) => fs.existsSync(c));
}

async function ensureInit(): Promise<void> {
  if (!holder.init) {
    holder.init = Parser.init({
      locateFile(name: string) {
        const p = grammarPath("web-tree-sitter", name);
        return p ?? name;
      },
    });
  }
  await holder.init;
}

export function grammarKeyFor(language: string, filePath: string): string | undefined {
  if (language === "TypeScript") return /\.tsx$/i.test(filePath) ? "TSX" : "TypeScript";
  if (language === "JavaScript") return /\.jsx$/i.test(filePath) ? "TSX" : "JavaScript";
  return GRAMMARS[language] ? language : undefined;
}

export async function loadLanguage(key: string): Promise<Language | null> {
  await ensureInit();
  if (!holder.languages.has(key)) {
    const g = GRAMMARS[key];
    const p = g ? grammarPath(g.pkg, g.file) : undefined;
    holder.languages.set(
      key,
      p ? Language.load(p).catch(() => null) : Promise.resolve(null),
    );
  }
  return holder.languages.get(key)!;
}

export async function parseWithTreeSitter(key: string, source: string): Promise<Tree | null> {
  const lang = await loadLanguage(key);
  if (!lang) return null;
  const parser = new Parser();
  parser.setLanguage(lang);
  try {
    return parser.parse(source);
  } finally {
    parser.delete();
  }
}

export type { Node, Tree };
