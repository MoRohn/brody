import { detectLanguage, SOURCE_LANGUAGES } from "./languages";

export type FileClassification =
  | "source" | "test" | "config" | "docs" | "schema" | "ci" | "infra" | "manifest"
  | "generated" | "vendor" | "binary" | "data" | "asset" | "lockfile" | "other";

export const DEFAULT_EXCLUDED_DIRS = [
  ".git", "node_modules", "dist", "build", "coverage", ".next", "target", "vendor", "__pycache__", ".venv", "venv",
  ".turbo", ".cache", ".idea", ".vscode", "out", ".nuxt", ".svelte-kit", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "bower_components", ".gradle", ".terraform", "Pods", "DerivedData", ".parcel-cache", ".yarn",
];

const MANIFEST_NAMES = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.py", "setup.cfg", "pipfile",
  "go.mod", "cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "gemfile", "composer.json",
  "packages.config", "project.clj", "mix.exs", "pubspec.yaml", "environment.yml", "conda.yml",
]);

const CONFIG_NAMES = [
  "tsconfig", "jsconfig", ".eslintrc", "eslint.config", ".prettierrc", "prettier.config", "babel.config", ".babelrc",
  "webpack.config", "vite.config", "next.config", "nuxt.config", "svelte.config", "tailwind.config", "postcss.config",
  "jest.config", "vitest.config", "playwright.config", "cypress.config", "rollup.config", "tsup.config", "drizzle.config",
  ".editorconfig", ".npmrc", ".nvmrc", ".python-version", ".ruby-version", "tox.ini", "mypy.ini", "ruff.toml", "pytest.ini",
  ".flake8", "setup.cfg", "app.json", "vercel.json", "netlify.toml", "fly.toml", "render.yaml", "procfile", "nodemon.json",
  ".env", "config.", "settings.", "appsettings", "web.config", "manifest.json", "turbo.json", "lerna.json", "nx.json", ".golangci",
];

const SCHEMA_HINTS = [/\.prisma$/i, /schema\.(sql|graphql|gql|json|ts|js|py|rb)$/i, /migrations?\//i, /\/schema\//i, /\.sql$/i, /models?\.py$/i, /\/models?\//i, /openapi\.(json|ya?ml)$/i, /swagger\.(json|ya?ml)$/i, /\/db\//i, /\/database\//i, /\/entities\//i, /alembic\//i];

const CI_HINTS = [/^\.github\/workflows\//i, /^\.gitlab-ci\.yml$/i, /^\.circleci\//i, /^jenkinsfile$/i, /^\.travis\.yml$/i, /^azure-pipelines\.yml$/i, /^bitbucket-pipelines\.yml$/i, /^\.buildkite\//i, /^\.drone\.yml$/i, /^cloudbuild\.ya?ml$/i];

const INFRA_HINTS = [/dockerfile/i, /docker-compose.*\.ya?ml$/i, /compose\.ya?ml$/i, /\.tf$/i, /\.tfvars$/i, /\/k8s\//i, /\/kubernetes\//i, /\/helm\//i, /\/charts\//i, /\/terraform\//i, /\/infra(structure)?\//i, /\/deploy(ment)?\//i, /serverless\.ya?ml$/i, /^\.dockerignore$/i, /nginx\.conf$/i, /ansible/i, /pulumi/i, /cdk\.json$/i, /skaffold\.ya?ml$/i, /^\.platform\//i, /^\.ebextensions\//i, /^Procfile$/];

const TEST_HINTS = [/(^|\/)(tests?|__tests__|spec|specs|e2e|cypress|__mocks__|fixtures?)\//i, /\.(test|spec)\.[cm]?[jt]sx?$/i, /_test\.go$/i, /^test_.*\.py$/i, /_test\.py$/i, /tests?\.py$/i, /_spec\.rb$/i, /Tests?\.(java|kt|cs|swift)$/i, /\.test\.py$/i, /conftest\.py$/i, /testing\//i];

const DOC_HINTS = [/\.(md|mdx|markdown|rst|adoc|txt)$/i, /^docs?\//i, /^license/i, /^readme/i, /^changelog/i, /^contributing/i, /^code_of_conduct/i, /^authors/i, /^notice/i];

const GENERATED_HINTS = [/\.min\.(js|css)$/i, /\.(generated|gen)\.[a-z]+$/i, /\.d\.ts$/i, /_pb2?\.py$/i, /\.pb\.go$/i, /\/generated\//i, /\/__generated__\//i, /\.bundle\.js$/i, /\.map$/i, /\.snap$/i, /\.g\.(cs|dart)$/i, /^migrations\/\d+_.*\.py$/i, /prisma\/migrations\//i, /\.lock$/i, /-lock\.json$/i, /lock\.yaml$/i, /\.chunk\.js$/i];

const VENDOR_HINTS = [/(^|\/)(vendor|third[_-]?party|external|libs?\/vendor|node_modules|bower_components)\//i];

const ASSET_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "woff", "woff2", "ttf", "otf", "eot", "pdf", "psd", "ai", "sketch", "fig"]);
const DATA_EXT = new Set(["csv", "tsv", "parquet", "xlsx", "xls", "db", "sqlite", "sqlite3", "ndjson", "jsonl", "avro", "arrow", "pkl", "pickle", "npy", "npz", "h5", "hdf5", "bin", "dat"]);
const BINARY_EXT = new Set(["exe", "dll", "so", "dylib", "a", "o", "class", "jar", "war", "ear", "pyc", "pyo", "wasm", "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso", "img", "apk", "ipa", "deb", "rpm", "msi", "node"]);

export interface Classified {
  classification: FileClassification;
  isTest: boolean;
  isGenerated: boolean;
  isVendor: boolean;
  isExcludedByDefault: boolean;
  excludeReason?: string;
  language: string;
}

export function isDefaultExcludedPath(path: string): string | undefined {
  const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (DEFAULT_EXCLUDED_DIRS.includes(parts[i])) return `inside ${parts[i]}/`;
  }
  if (parts[parts.length - 1] === ".DS_Store" || parts[parts.length - 1] === "Thumbs.db") return "OS metadata";
  return undefined;
}

export function classifyPath(path: string, opts: { isBinary?: boolean } = {}): Classified {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const language = detectLanguage(path);
  const excludeReason = isDefaultExcludedPath(path);
  const isVendor = VENDOR_HINTS.some((r) => r.test(path));
  const isGenerated = GENERATED_HINTS.some((r) => r.test(path));
  const isTest = TEST_HINTS.some((r) => r.test(path));

  let classification: FileClassification = "other";
  if (opts.isBinary || BINARY_EXT.has(ext)) classification = "binary";
  else if (ASSET_EXT.has(ext)) classification = "asset";
  else if (DATA_EXT.has(ext)) classification = "data";
  else if (language === "Lockfile" || /lock/.test(lower) && /\.(json|yaml|yml|lock)$/.test(lower)) classification = "lockfile";
  else if (isVendor) classification = "vendor";
  else if (CI_HINTS.some((r) => r.test(path))) classification = "ci";
  else if (INFRA_HINTS.some((r) => r.test(path)) || language === "Dockerfile" || language === "Terraform") classification = "infra";
  else if (MANIFEST_NAMES.has(lower)) classification = "manifest";
  else if (isTest && SOURCE_LANGUAGES.has(language)) classification = "test";
  else if (isGenerated && SOURCE_LANGUAGES.has(language)) classification = "generated";
  else if (SCHEMA_HINTS.some((r) => r.test(path)) && (language === "SQL" || language === "Prisma" || language === "GraphQL" || /schema|model|migration|entit/i.test(path))) classification = "schema";
  else if (SOURCE_LANGUAGES.has(language)) classification = "source";
  else if (DOC_HINTS.some((r) => r.test(path)) || language === "Markdown") classification = "docs";
  else if (CONFIG_NAMES.some((c) => lower.startsWith(c) || lower === c) || ["JSON", "YAML", "TOML", "INI", "Dotenv", "XML", "Gitignore"].includes(language)) classification = "config";
  else classification = "other";

  return { classification, isTest, isGenerated, isVendor, isExcludedByDefault: !!excludeReason, excludeReason, language };
}
