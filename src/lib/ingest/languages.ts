/** Language detection by file extension and well-known filenames. */
const EXT_MAP: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", pyi: "Python",
  go: "Go",
  java: "Java",
  kt: "Kotlin", kts: "Kotlin",
  cs: "C#",
  rb: "Ruby",
  rs: "Rust",
  php: "PHP",
  swift: "Swift",
  scala: "Scala",
  c: "C", h: "C",
  cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", hh: "C++",
  html: "HTML", htm: "HTML",
  css: "CSS", scss: "SCSS", sass: "SCSS", less: "Less",
  sql: "SQL",
  json: "JSON", jsonc: "JSON",
  yaml: "YAML", yml: "YAML",
  toml: "TOML",
  md: "Markdown", mdx: "Markdown", markdown: "Markdown",
  sh: "Shell", bash: "Shell", zsh: "Shell",
  ps1: "PowerShell",
  prisma: "Prisma",
  graphql: "GraphQL", gql: "GraphQL",
  proto: "Protobuf",
  tf: "Terraform", hcl: "Terraform",
  vue: "Vue", svelte: "Svelte",
  xml: "XML", svg: "SVG",
  txt: "Text",
  env: "Dotenv",
  ini: "INI", cfg: "INI", conf: "INI",
  lock: "Lockfile",
  csv: "CSV",
  ipynb: "Jupyter",
  dart: "Dart",
  ex: "Elixir", exs: "Elixir",
  lua: "Lua",
  r: "R",
  pl: "Perl",
  m: "Objective-C",
};

const NAME_MAP: Record<string, string> = {
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  "cmakelists.txt": "CMake",
  gemfile: "Ruby",
  rakefile: "Ruby",
  "package.json": "JSON",
  procfile: "Procfile",
  ".gitignore": "Gitignore",
  ".dockerignore": "Gitignore",
  ".env": "Dotenv",
  ".env.example": "Dotenv",
  ".env.local": "Dotenv",
  "go.mod": "Go Module",
  "go.sum": "Lockfile",
  "cargo.lock": "Lockfile",
  "yarn.lock": "Lockfile",
  "pnpm-lock.yaml": "Lockfile",
  "package-lock.json": "Lockfile",
  "poetry.lock": "Lockfile",
  "composer.lock": "Lockfile",
  "gemfile.lock": "Lockfile",
  ".babelrc": "JSON",
  ".eslintrc": "JSON",
  ".prettierrc": "JSON",
};

/** Languages that have AST support through tree-sitter grammars. */
export const AST_LANGUAGES = new Set([
  "TypeScript", "JavaScript", "Python", "Go", "Java", "C#", "Ruby", "Rust", "PHP", "CSS", "HTML", "JSON", "Shell",
]);

/** Languages considered program source (as opposed to config/docs/data). */
export const SOURCE_LANGUAGES = new Set([
  "TypeScript", "JavaScript", "Python", "Go", "Java", "Kotlin", "C#", "Ruby", "Rust", "PHP", "Swift", "Scala", "C", "C++",
  "Vue", "Svelte", "Dart", "Elixir", "Lua", "R", "Perl", "Objective-C", "SQL", "Prisma", "GraphQL", "Shell", "HTML", "CSS", "SCSS", "Less",
]);

export function detectLanguage(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const lower = name.toLowerCase();
  if (NAME_MAP[lower]) return NAME_MAP[lower];
  if (lower.startsWith("dockerfile.")) return "Dockerfile";
  if (lower.startsWith(".env")) return "Dotenv";
  const idx = lower.lastIndexOf(".");
  if (idx <= 0) return "Text";
  const ext = lower.slice(idx + 1);
  return EXT_MAP[ext] ?? "Unknown";
}

export function extensionOf(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
}
