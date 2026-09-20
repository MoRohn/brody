import { extractFromTree } from "./extract";
import { grammarKeyFor, parseWithTreeSitter } from "./treesitter";
import { parseConfig, parseGeneric, parseGraphql, parseMarkdown, parsePrisma, parseSql } from "./textfallback";
import { emptyParse, type ParsedFile } from "./types";

export * from "./types";

const MAX_AST_BYTES = 600 * 1024;

/**
 * Parse one file into symbols, imports, calls and relationships. AST parsing
 * is used when a grammar exists; otherwise a documented text fallback runs.
 */
export async function parseFile(filePath: string, language: string, source: string): Promise<ParsedFile> {
  if (!source.trim()) return emptyParse("skipped", "none");
  const key = grammarKeyFor(language, filePath);
  if (key && source.length <= MAX_AST_BYTES) {
    try {
      const tree = await parseWithTreeSitter(key, source);
      if (tree) {
        try {
          return extractFromTree(language, key, tree, source, filePath);
        } finally {
          tree.delete();
        }
      }
    } catch (e) {
      const fb = fallback(filePath, language, source);
      fb.error = `AST parse failed (${e instanceof Error ? e.message : String(e)}); used text fallback`;
      return fb;
    }
  }
  const fb = fallback(filePath, language, source);
  if (key && source.length > MAX_AST_BYTES) fb.error = "file too large for AST parsing; used text fallback";
  return fb;
}

function fallback(filePath: string, language: string, source: string): ParsedFile {
  switch (language) {
    case "SQL": return parseSql(source);
    case "Prisma": return parsePrisma(source);
    case "GraphQL": return parseGraphql(source);
    case "Markdown": return parseMarkdown(source);
    case "YAML": case "TOML": case "INI": case "Dotenv": case "Dockerfile": case "Terraform": return parseConfig(source, language);
    case "Text": case "Unknown": case "Lockfile": case "CSV": case "XML": case "SVG": case "Gitignore": case "Procfile": return emptyParse("skipped", "none");
    default: return parseGeneric(source, language);
  }
}
