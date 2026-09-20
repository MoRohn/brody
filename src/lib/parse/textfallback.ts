import { emptyParse, type ParsedFile, type SymbolKind } from "./types";

function lineNumberAt(src: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function blockEnd(src: string, startIdx: number): number {
  // Find matching closing brace from the first "{" after startIdx; fall back to same line.
  const open = src.indexOf("{", startIdx);
  if (open < 0) return lineNumberAt(src, startIdx);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return lineNumberAt(src, i);
    }
  }
  return lineNumberAt(src, src.length - 1);
}

/** SQL: tables, views, functions, indexes. */
export function parseSql(src: string): ParsedFile {
  const out = emptyParse("text", "text:sql");
  const re = /create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(table|view|materialized\s+view|function|procedure|index|unique\s+index|type|trigger|schema|extension)\s+(?:if\s+not\s+exists\s+)?["`]?([\w.]+)["`]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const what = m[1].toLowerCase();
    const name = m[2].split(".").pop()!;
    const kind: SymbolKind = what === "table" ? "table" : what.includes("view") ? "model" : what.includes("index") ? "property" : what === "function" || what === "procedure" ? "function" : "schema";
    const start = lineNumberAt(src, m.index);
    const end = what === "table" || what === "function" || what === "procedure" ? blockEnd(src, m.index) : start;
    const meta: Record<string, unknown> = {};
    if (what === "table") {
      const open = src.indexOf("(", m.index + m[0].length);
      let depth = 0, close = -1;
      for (let i = open; i >= 0 && i < src.length && i < open + 20000; i++) { if (src[i] === "(") depth++; else if (src[i] === ")") { depth--; if (depth === 0) { close = i; break; } } }
      const inner = open >= 0 ? src.slice(open + 1, close > 0 ? close : open + 4000) : "";
      const parts: string[] = [];
      let d = 0, cur = "";
      for (const ch of inner) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { parts.push(cur); cur = ""; } else cur += ch; }
      if (cur.trim()) parts.push(cur);
      const cols: string[] = [];
      const refs: string[] = [];
      for (const part of parts) {
        const t = part.trim();
        const first = t.match(/^["`]?([a-zA-Z_]\w*)["`]?/)?.[1];
        if (first && !/^(constraint|primary|foreign|unique|check|key|index|exclude|like)$/i.test(first)) cols.push(first);
        const r = t.match(/references\s+["`]?([\w.]+)["`]?/i);
        if (r) refs.push(r[1].split(".").pop()!);
      }
      meta.fields = cols.slice(0, 80);
      if (refs.length) meta.references = [...new Set(refs)];
    }
    out.symbols.push({ index: out.symbols.length, name, qualifiedName: name, kind, startLine: start, endLine: end, signature: m[0].slice(0, 160), exported: true, visibility: "public", meta: Object.keys(meta).length ? meta : undefined });
  }
  for (const m2 of src.matchAll(/\b(?:from|join|into|update)\s+["`]?([a-zA-Z_][\w.]*)["`]?/gi)) out.identifiers.add(m2[1].split(".").pop()!);
  for (const m3 of src.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+["`]?([a-zA-Z_][\w.]*)["`]?/gi)) out.calls.push({ name: m3[1].split(".").pop()!, expression: m3[0].slice(0, 60), line: lineNumberAt(src, m3.index ?? 0) });
  return out;
}

/** Prisma schema: models, enums, datasource, relations. */
export function parsePrisma(src: string): ParsedFile {
  const out = emptyParse("text", "text:prisma");
  const re = /^(model|enum|type|datasource|generator)\s+(\w+)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = lineNumberAt(src, m.index);
    const end = blockEnd(src, m.index);
    const body = src.slice(src.indexOf("{", m.index) + 1, src.indexOf("}", m.index));
    const fields: string[] = [];
    const relations: string[] = [];
    for (const line of body.split("\n")) {
      const f = line.trim().match(/^(\w+)\s+([A-Z]\w*)(\[\])?\??/);
      if (f) {
        fields.push(f[1]);
        if (/^[A-Z]/.test(f[2]) && !/^(String|Int|Float|Boolean|DateTime|Json|Bytes|Decimal|BigInt)$/.test(f[2])) relations.push(f[2]);
      }
    }
    const kind: SymbolKind = m[1] === "model" ? "model" : m[1] === "enum" ? "enum" : m[1] === "type" ? "type" : "constant";
    const idx = out.symbols.length;
    out.symbols.push({ index: idx, name: m[2], qualifiedName: m[2], kind, startLine: start, endLine: end, signature: `${m[1]} ${m[2]}`, exported: true, visibility: "public", meta: { fields: fields.slice(0, 80), references: [...new Set(relations)], provider: m[1] === "datasource" ? body.match(/provider\s*=\s*"(\w+)"/)?.[1] : undefined } });
    for (const r of new Set(relations)) out.inheritance.push({ childIndex: idx, parentName: r, kind: "IMPLEMENTS" });
  }
  out.exports = out.symbols.map((s) => s.name);
  return out;
}

/** GraphQL SDL. */
export function parseGraphql(src: string): ParsedFile {
  const out = emptyParse("text", "text:graphql");
  const re = /^(?:extend\s+)?(type|interface|input|enum|union|scalar|schema)\s+(\w+)?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[2] ?? m[1];
    const kind: SymbolKind = m[1] === "type" && /^(Query|Mutation|Subscription)$/.test(name) ? "endpoint" : m[1] === "enum" ? "enum" : m[1] === "interface" ? "interface" : "schema";
    out.symbols.push({ index: out.symbols.length, name, qualifiedName: name, kind, startLine: lineNumberAt(src, m.index), endLine: blockEnd(src, m.index), signature: m[0], exported: true, visibility: "public" });
  }
  out.exports = out.symbols.map((s) => s.name);
  return out;
}

/** Markdown: headings become sections for retrieval. */
export function parseMarkdown(src: string): ParsedFile {
  const out = emptyParse("text", "text:markdown");
  const lines = src.split("\n");
  const stack: number[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (!m) return;
    const level = m[1].length;
    while (stack.length && (out.symbols[stack[stack.length - 1]].meta?.level as number) >= level) {
      const idx = stack.pop()!;
      out.symbols[idx].endLine = i;
    }
    const idx = out.symbols.length;
    out.symbols.push({ index: idx, name: m[2].slice(0, 120), qualifiedName: m[2].slice(0, 120), kind: "section", startLine: i + 1, endLine: lines.length, signature: line.slice(0, 160), exported: true, visibility: "public", meta: { level }, parentIndex: stack[stack.length - 1] });
    stack.push(idx);
  });
  for (const m of src.matchAll(/\]\(([^)\s]+)\)/g)) if (!/^https?:/.test(m[1]) && !m[1].startsWith("#")) out.imports.push({ specifier: m[1], names: [], line: lineNumberAt(src, m.index ?? 0) });
  return out;
}

/** YAML/TOML/INI: top-level keys for retrieval; docker-compose services. */
export function parseConfig(src: string, language: string): ParsedFile {
  const out = emptyParse("text", `text:${language.toLowerCase()}`);
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const m = line.match(/^([A-Za-z_][\w.-]*)\s*[:=]/);
    if (m) out.identifiers.add(m[1]);
    const sec = line.match(/^\[([\w.-]+)\]/);
    if (sec) out.symbols.push({ index: out.symbols.length, name: sec[1], qualifiedName: sec[1], kind: "section", startLine: i + 1, endLine: i + 1, signature: line.trim(), exported: true, visibility: "public" });
  });
  if (/^services:\s*$/m.test(src)) {
    const svcIdx = src.search(/^services:\s*$/m);
    const rest = src.slice(svcIdx);
    for (const m of rest.matchAll(/^  ([A-Za-z_][\w.-]*):\s*$/gm)) {
      const line = lineNumberAt(src, svcIdx + (m.index ?? 0));
      const block = rest.slice(m.index ?? 0, rest.indexOf("\n  ", (m.index ?? 0) + 3 + m[1].length + 1) > 0 ? undefined : undefined);
      const image = block.match(/^\s+image:\s*(\S+)/m)?.[1];
      out.symbols.push({ index: out.symbols.length, name: m[1], qualifiedName: `services.${m[1]}`, kind: "service", startLine: line, endLine: line, signature: `service ${m[1]}${image ? ` (${image})` : ""}`, exported: true, visibility: "public", meta: { image, composeService: true } });
    }
  }
  if (/^\s*(jobs|on):\s*$/m.test(src) && /runs-on:/.test(src)) {
    for (const m of src.matchAll(/^  ([A-Za-z_][\w-]*):\s*$/gm)) {
      const after = src.slice((m.index ?? 0), (m.index ?? 0) + 400);
      if (/runs-on:|uses:/.test(after)) out.symbols.push({ index: out.symbols.length, name: m[1], qualifiedName: `jobs.${m[1]}`, kind: "job", startLine: lineNumberAt(src, m.index ?? 0), endLine: lineNumberAt(src, m.index ?? 0), signature: `workflow job ${m[1]}`, exported: true, visibility: "public", meta: { ciJob: true } });
    }
  }
  return out;
}

/** Generic regex extraction for languages without a grammar (Kotlin, Swift, Scala, C, C++, Dart, Vue, Svelte, ...). */
export function parseGeneric(src: string, language: string): ParsedFile {
  const out = emptyParse("text", `text:generic`);
  const patterns: { re: RegExp; kind: SymbolKind }[] = [
    { re: /^\s*(?:export\s+)?(?:public|private|protected|internal|open|abstract|final|static|override|data|sealed)?\s*(?:class|struct|interface|enum(?:\s+class)?|object|trait|protocol|actor|record)\s+([A-Za-z_]\w*)/gm, kind: "class" },
    { re: /^\s*(?:export\s+)?(?:public|private|protected|internal|open|static|override|suspend|inline|async|virtual|extern)?\s*(?:fun|func|def|function|fn|proc|sub)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, kind: "function" },
    { re: /^\s*(?:[A-Za-z_][\w<>:*&,\s]*?)\s+\**([A-Za-z_]\w*)\s*\([^;{]*\)\s*(?:const\s*)?\{/gm, kind: "function" },
    { re: /^\s*(?:val|let|const|static\s+const|constexpr)\s+([A-Z][A-Z0-9_]+)\b/gm, kind: "constant" },
    { re: /^\s*#define\s+([A-Za-z_]\w*)/gm, kind: "constant" },
    { re: /^\s*typedef\s+(?:struct|enum|union)?\s*[^;]*?([A-Za-z_]\w*)\s*;/gm, kind: "type" },
  ];
  const seen = new Set<string>();
  for (const { re, kind } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const name = m[1];
      if (!name || /^(if|for|while|switch|return|else|catch|sizeof|new|delete|do)$/.test(name)) continue;
      if (kind === "function" && /^\s*(class|struct|interface|enum|object|trait|protocol)\b/.test(m[0])) continue;
      const key = `${name}:${lineNumberAt(src, m.index)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const start = lineNumberAt(src, m.index);
      const end = kind === "constant" || kind === "type" ? start : blockEnd(src, m.index);
      out.symbols.push({ index: out.symbols.length, name, qualifiedName: name, kind: language === "Vue" || language === "Svelte" ? kind : kind, startLine: start, endLine: Math.max(start, end), signature: m[0].trim().slice(0, 160), exported: !/^\s*(private|internal|fileprivate|static)/.test(m[0]), visibility: /private/.test(m[0]) ? "private" : "public" });
    }
  }
  for (const m of src.matchAll(/^\s*(?:import|#include|using|require|@import)\s+(?:static\s+)?[<"']?([\w./:@-]+)[>"']?/gm)) out.imports.push({ specifier: m[1].replace(/;$/, ""), names: [m[1].split(/[./]/).pop() ?? m[1]], line: lineNumberAt(src, m.index ?? 0) });
  for (const m of src.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[1];
    if (/^(if|for|while|switch|return|catch|sizeof|fun|func|def|function|fn|class|struct|new|delete|do|else)$/.test(name)) continue;
    if (out.calls.length < 2000) out.calls.push({ name, expression: name, line: lineNumberAt(src, m.index ?? 0), callerIndex: out.symbols.find((s) => s.startLine <= lineNumberAt(src, m.index ?? 0) && s.endLine >= lineNumberAt(src, m.index ?? 0))?.index });
  }
  for (const m of src.matchAll(/\b([A-Za-z_]\w{2,})\b/g)) if (out.identifiers.size < 5000) out.identifiers.add(m[1]);
  out.exports = out.symbols.filter((s) => s.exported).map((s) => s.name);
  if (language === "Vue" || language === "Svelte") {
    const name = "component";
    out.symbols.unshift({ index: 0, name, qualifiedName: name, kind: "component", startLine: 1, endLine: src.split("\n").length, signature: `<${language.toLowerCase()} component>`, exported: true, visibility: "public" });
    out.symbols.forEach((s, i) => (s.index = i));
  }
  return out;
}
