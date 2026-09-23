import type { Node, Tree } from "./treesitter";
import { createComplexity } from "./complexity";
import { emptyParse, type ParsedFile, type ParsedSymbol, type SymbolKind } from "./types";

/** The parse warning for a file the tree-sitter grammar could not fully parse. */
export const SYNTAX_WARNING = "syntax errors present; extraction may be partial";

interface Ctx {
  src: string;
  out: ParsedFile;
  language: string;
  filePath: string;
}

function text(n: Node | null | undefined, max = 200): string {
  if (!n) return "";
  const t = n.text;
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function argsOf(call: Node): string[] {
  const a = call.childForFieldName("arguments") ?? call.namedChildren.find((c) => /^(arguments|argument_list|call_arguments)$/.test(c.type));
  if (!a) return [];
  return a.namedChildren.filter((c) => c.type !== "comment").slice(0, 4).map((c) => (c.text.length > 100 ? c.text.slice(0, 100) + "…" : c.text));
}

function lineOf(n: Node): number {
  return n.startPosition.row + 1;
}

function endLineOf(n: Node): number {
  return n.endPosition.row + 1;
}

function firstLine(n: Node, max = 200): string {
  const t = n.text.split("\n")[0].trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** Collect the doc comment immediately preceding a node. */
function docBefore(n: Node): string | undefined {
  let prev = n.previousNamedSibling;
  // Skip over decorators / annotations on the same declaration.
  while (prev && /decorator|annotation|attribute_list|marker_annotation|modifiers/.test(prev.type)) prev = prev.previousNamedSibling;
  if (!prev) {
    const parent = n.parent;
    if (parent && /export_statement|decorated_definition|attribute_item|declaration_list/.test(parent.type)) return docBefore(parent);
    return undefined;
  }
  if (/comment/.test(prev.type) && prev.endPosition.row >= n.startPosition.row - 2) {
    return cleanComment(prev.text);
  }
  return undefined;
}

function cleanComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?|\*\/$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/^\s*(\/\/\/?|#)\s?/gm, "")
    .replace(/^"""|"""$/g, "")
    .trim()
    .slice(0, 600);
}

function pyDocstring(body: Node | null): string | undefined {
  if (!body) return undefined;
  const first = body.namedChildren[0];
  if (first?.type === "expression_statement" && first.namedChildren[0]?.type === "string") {
    return cleanComment(first.namedChildren[0].text.replace(/^[rbuRBU]*("""|'''|"|')/, "").replace(/("""|'''|"|')$/, ""));
  }
  return undefined;
}

function addSymbol(ctx: Ctx, s: Omit<ParsedSymbol, "index" | "qualifiedName"> & { qualifiedName?: string }): number {
  const index = ctx.out.symbols.length;
  const parent = s.parentIndex !== undefined ? ctx.out.symbols[s.parentIndex] : undefined;
  const qualifiedName = s.qualifiedName ?? (parent ? `${parent.qualifiedName}.${s.name}` : s.name);
  ctx.out.symbols.push({ ...s, index, qualifiedName });
  return index;
}

const complexityByTree = new WeakMap<object, (n: Node) => number>();
/** Rough cyclomatic complexity of a node; the branch index for its tree is built once, on first use. */
function complexityOf(n: Node): number {
  let f = complexityByTree.get(n.tree);
  if (!f) { f = createComplexity(n.tree.rootNode); complexityByTree.set(n.tree, f); }
  return f(n);
}

function walk(n: Node, visit: (node: Node, depth: number) => boolean | void, depth = 0): void {
  const cont = visit(n, depth);
  if (cont === false) return;
  for (const ch of n.namedChildren) walk(ch, visit, depth + 1);
}

function collectIdentifierNodes(nodes: Node[], out: Set<string>): void {
  for (const id of nodes) {
    const t = id.text;
    if (t.length > 1 && t.length < 80) out.add(t);
  }
}

function collectIdentifiers(root: Node, out: Set<string>, types: string[]): void {
  collectIdentifierNodes(root.descendantsOfType(types), out);
}

/**
 * One native scan for every node type an extractor will ask about. Each request is then answered from memory, in document
 * order, instead of walking the whole tree again: the TypeScript extractor used to make six whole-file scans (imports, calls
 * twice, exports, identifiers) plus one scan inside every export statement, together about a third of extraction time.
 */
function nodeScan(root: Node, types: string[]) {
  const nodes = root.descendantsOfType(types);
  const kinds = nodes.map((n) => n.type);
  const buckets = new Map<string, Node[]>();
  nodes.forEach((n, i) => { const b = buckets.get(kinds[i]); if (b) b.push(n); else buckets.set(kinds[i], [n]); });
  return {
    /** Nodes of these types, in document order. */
    of(...want: string[]): Node[] {
      if (want.length === 1) return buckets.get(want[0]) ?? [];
      const set = new Set(want);
      return nodes.filter((_, i) => set.has(kinds[i]));
    },
    /** Nodes of one type inside `container` (a proper subtree, so a range test is exact), in document order. */
    within(type: string, container: Node): Node[] {
      const list = buckets.get(type);
      if (!list || list.length === 0) return [];
      const from = container.startIndex, to = container.endIndex;
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].startIndex < from) lo = mid + 1; else hi = mid; }
      const out: Node[] = [];
      for (let i = lo; i < list.length && list[i].startIndex < to; i++) if (list[i].endIndex <= to) out.push(list[i]);
      return out;
    },
  };
}

/** Determine the enclosing symbol index for a node given recorded symbol ranges. */
function enclosingSymbol(ctx: Ctx, line: number): number | undefined {
  let best: number | undefined;
  let bestSpan = Infinity;
  for (const s of ctx.out.symbols) {
    if (s.startLine <= line && s.endLine >= line) {
      const span = s.endLine - s.startLine;
      if (span < bestSpan) {
        best = s.index;
        bestSpan = span;
      }
    }
  }
  return best;
}

function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function containsJsx(n: Node): boolean {
  return n.descendantsOfType(["jsx_element", "jsx_self_closing_element", "jsx_fragment"]).length > 0;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------
function extractTsJs(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  const { out } = ctx;
  const exportedNames = new Set<string>();
  const scan = nodeScan(root, ["import_statement", "call_expression", "new_expression", "export_statement", "export_specifier", "identifier", "type_identifier", "property_identifier", "jsx_identifier"]);

  // Imports
  for (const imp of scan.of("import_statement")) {
    const src = imp.childForFieldName("source");
    if (!src) continue;
    const spec = src.text.replace(/^['"`]|['"`]$/g, "");
    const names: string[] = [];
    for (const id of imp.descendantsOfType(["import_specifier", "namespace_import", "identifier"])) {
      if (id.type === "import_specifier") names.push((id.childForFieldName("alias") ?? id.childForFieldName("name"))?.text ?? id.text);
      else if (id.type === "namespace_import") names.push(id.namedChildren[0]?.text ?? "*");
      else if (id.parent?.type === "import_clause") names.push(id.text);
    }
    const isTypeOnly = /^import\s+type\b/.test(imp.text);
    out.imports.push({ specifier: spec, names: [...new Set(names)], line: lineOf(imp), isTypeOnly });
  }
  // require() and dynamic import()
  for (const call of scan.of("call_expression")) {
    const fn = call.childForFieldName("function");
    const args = call.childForFieldName("arguments");
    const first = args?.namedChildren[0];
    if (fn && first && (fn.text === "require" || fn.type === "import") && (first.type === "string" || first.type === "template_string")) {
      const spec = first.text.replace(/^['"`]|['"`]$/g, "");
      const names: string[] = [];
      const decl = call.parent?.type === "variable_declarator" ? call.parent : undefined;
      const nameNode = decl?.childForFieldName("name");
      if (nameNode?.type === "identifier") names.push(nameNode.text);
      else if (nameNode) for (const id of nameNode.descendantsOfType("shorthand_property_identifier_pattern")) names.push(id.text);
      out.imports.push({ specifier: spec, names, line: lineOf(call) });
    }
  }
  // export names
  for (const exp of scan.of("export_statement")) {
    const specs = scan.within("export_specifier", exp);
    for (const spec of specs) exportedNames.add((spec.childForFieldName("alias") ?? spec.childForFieldName("name"))?.text ?? "");
    if (/^export\s+default\b/.test(exp.text)) exportedNames.add("default");
    if (/^export\s+\*\s+from/.test(exp.text)) exportedNames.add("*");
    const src = exp.childForFieldName("source");
    if (src) out.imports.push({ specifier: src.text.replace(/^['"`]|['"`]$/g, ""), names: specs.map((sp) => sp.childForFieldName("name")?.text ?? "").filter(Boolean), line: lineOf(exp) });
  }

  const declTypes = [
    "function_declaration", "generator_function_declaration", "class_declaration", "abstract_class_declaration", "interface_declaration",
    "type_alias_declaration", "enum_declaration", "method_definition", "lexical_declaration", "variable_declaration", "method_signature",
    "public_field_definition", "internal_module", "module",
  ];

  walk(root, (n) => {
    if (!declTypes.includes(n.type)) return;
    const isExported = n.parent?.type === "export_statement" || (n.parent?.parent?.type === "export_statement");
    const exportDefault = n.parent?.type === "export_statement" && /^export\s+default\b/.test(n.parent.text);
    const parentIdx = enclosingSymbol(ctx, lineOf(n));
    const parentSym = parentIdx !== undefined ? out.symbols[parentIdx] : undefined;

    if (n.type === "lexical_declaration" || n.type === "variable_declaration") {
      // Only top-level or exported declarations count (avoid locals).
      const isTopLevel = n.parent?.type === "program" || n.parent?.type === "export_statement";
      if (!isTopLevel) return;
      for (const d of n.namedChildren.filter((c) => c.type === "variable_declarator")) {
        const nameNode = d.childForFieldName("name");
        const value = d.childForFieldName("value");
        if (!nameNode || nameNode.type !== "identifier") continue;
        const name = nameNode.text;
        const isFn = value && /arrow_function|function_expression|function|generator_function/.test(value.type);
        let kind: SymbolKind = isFn ? "function" : /^const/.test(n.text) && /^[A-Z0-9_]+$/.test(name) ? "constant" : "variable";
        const meta: Record<string, unknown> = {};
        if (isFn && value) {
          if (/^use[A-Z]/.test(name)) kind = "hook";
          else if (isComponentName(name) && containsJsx(value)) kind = "component";
        } else if (value && /call_expression/.test(value.type)) {
          const callee = value.childForFieldName("function")?.text ?? "";
          if (/Router\(|express\.Router|new Hono|createRouter/.test(value.text)) kind = "service";
          if (/(sqliteTable|pgTable|mysqlTable|mongoose\.model|new Schema|sequelize\.define|\.define\(|defineTable|createTable)/.test(callee + value.text.slice(0, 200))) {
            kind = "model";
            const m = value.text.match(/\(\s*['"`]([A-Za-z0-9_]+)['"`]/);
            if (m) meta.table = m[1];
          }
          if (/(forwardRef|memo|styled\.|styled\()/.test(callee) && isComponentName(name)) kind = "component";
          if (/createSlice|createStore|create\(|defineStore|atom\(|createContext/.test(callee)) meta.state = true;
        }
        const idx = addSymbol(ctx, {
          name, kind, startLine: lineOf(d), endLine: endLineOf(d), signature: firstLine(d), exported: isExported || exportedNames.has(name),
          visibility: isExported ? "public" : "internal", documentation: docBefore(n), parentIndex: undefined, meta: Object.keys(meta).length ? meta : undefined,
        });
        if (isFn && value) out.complexity.set(idx, complexityOf(value));
      }
      return;
    }

    const nameNode = n.childForFieldName("name");
    let name = nameNode?.text ?? (exportDefault ? "default" : undefined);
    if (!name) return;
    if (n.type === "method_definition" || n.type === "method_signature") {
      name = nameNode?.text ?? name;
    }
    let kind: SymbolKind = "function";
    switch (n.type) {
      case "class_declaration": case "abstract_class_declaration": kind = "class"; break;
      case "interface_declaration": kind = "interface"; break;
      case "type_alias_declaration": kind = "type"; break;
      case "enum_declaration": kind = "enum"; break;
      case "method_definition": case "method_signature": kind = "method"; break;
      case "public_field_definition": kind = "property"; break;
      case "internal_module": case "module": kind = "namespace"; break;
    }
    if (kind === "function") {
      if (/^use[A-Z]/.test(name)) kind = "hook";
      else if (isComponentName(name) && containsJsx(n)) kind = "component";
    }
    if (kind === "class") {
      const body = n.text.slice(0, 400);
      if (/(Service|Repository|Controller|Handler|Manager|Provider|Client|Gateway|Adapter|UseCase|Store)$/.test(name)) kind = "service";
      if (/extends\s+(React\.)?(Pure)?Component\b/.test(body)) kind = "component";
      if (/@Entity\(|@Table\(|@Schema\(/.test(n.parent?.text.slice(0, 200) ?? "")) kind = "model";
    }
    if (kind === "property" && parentSym?.kind !== "class") return;
    const modifiers = n.text.slice(0, 60);
    const visibility: ParsedSymbol["visibility"] = /\bprivate\b/.test(modifiers) || name.startsWith("#") ? "private" : /\bprotected\b/.test(modifiers) ? "protected" : isExported ? "public" : "internal";
    const decorators: string[] = [];
    let prev = n.previousNamedSibling;
    while (prev && prev.type === "decorator") {
      decorators.unshift(prev.text.slice(0, 120));
      prev = prev.previousNamedSibling;
    }
    if (n.parent?.type === "export_statement") {
      let p = n.parent.previousNamedSibling;
      while (p && p.type === "decorator") { decorators.unshift(p.text.slice(0, 120)); p = p.previousNamedSibling; }
    }
    for (const d of n.namedChildren) if (d.type === "decorator") decorators.push(d.text.slice(0, 120));
    if (decorators.some((d) => /@(Injectable|Service|Controller|Resolver|Module)\b/.test(d)) && kind === "class") kind = "service";
    if (decorators.some((d) => /@(Entity|Table|Schema|ObjectType|Model)\b/.test(d)) && kind === "class") kind = "model";
    if (decorators.some((d) => /@(Get|Post|Put|Patch|Delete|Query|Mutation|Route)\b/.test(d)) && kind === "method") kind = "endpoint";
    if (decorators.some((d) => /@(Cron|Process|Interval|OnEvent|EventPattern|MessagePattern|Subscribe)\b/.test(d))) kind = /OnEvent|EventPattern|MessagePattern|Subscribe/.test(decorators.join(" ")) ? "event_handler" : "job";
    const idx = addSymbol(ctx, {
      name, kind, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported: isExported || exportedNames.has(name),
      visibility, documentation: docBefore(n), parentIndex: kind === "method" || kind === "property" || kind === "endpoint" ? parentIdx : undefined,
    });
    if (decorators.length) out.decorators.set(idx, decorators);
    if (kind !== "class" && kind !== "interface" && kind !== "type" && kind !== "enum" && kind !== "namespace") out.complexity.set(idx, complexityOf(n));
    // Inheritance
    if (kind === "class" || kind === "service" || kind === "model" || kind === "component" || kind === "interface") {
      for (const h of n.descendantsOfType(["class_heritage", "extends_type_clause"])) {
        if (h.parent?.id !== n.id && h.parent?.parent?.id !== n.id) continue;
        const isImpl = h.type === "implements_clause";
        for (const t of h.namedChildren) {
          const nm = t.type === "extends_clause" || t.type === "implements_clause" ? undefined : t.text.replace(/<.*$/, "");
          if (nm && /^[A-Za-z_$][\w$.]*$/.test(nm)) out.inheritance.push({ childIndex: idx, parentName: nm, kind: isImpl ? "IMPLEMENTS" : "EXTENDS" });
          if (t.type === "extends_clause" || t.type === "implements_clause") {
            for (const tt of t.namedChildren) {
              const n2 = tt.text.replace(/<.*$/, "");
              if (/^[A-Za-z_$][\w$.]*$/.test(n2)) out.inheritance.push({ childIndex: idx, parentName: n2, kind: t.type === "implements_clause" ? "IMPLEMENTS" : "EXTENDS" });
            }
          }
        }
      }
    }
  });

  // Inline route handlers (app.get("/x", (req, res) => ...)) become endpoint symbols so their calls are attributed correctly.
  const ROUTE_OBJ = /^(app|router|server|api|fastify|hono|r|route|routes|v\d+|admin|public|private|koa|instance|\w*[Rr]outer|\w*[Aa]pp)$/;
  for (const call of scan.of("call_expression")) {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "member_expression") continue;
    const obj = fn.childForFieldName("object")?.text ?? "";
    const prop = fn.childForFieldName("property")?.text ?? "";
    if (!/^(get|post|put|patch|delete|del|all|options|head)$/.test(prop) || !ROUTE_OBJ.test(obj)) continue;
    const named = (call.childForFieldName("arguments")?.namedChildren ?? []).filter((c) => c.type !== "comment");
    const first = named[0];
    if (!first || (first.type !== "string" && first.type !== "template_string")) continue;
    const routePath = first.text.replace(/^['"`]|['"`]$/g, "");
    if (!routePath.startsWith("/") && routePath !== "*") continue;
    const last = named[named.length - 1];
    if (!last || !/^(arrow_function|function_expression|function)$/.test(last.type)) continue;
    const method = prop === "del" ? "DELETE" : prop.toUpperCase();
    const idx = addSymbol(ctx, { name: `${method} ${routePath}`, kind: "endpoint", startLine: lineOf(last), endLine: endLineOf(last), signature: firstLine(call), exported: false, visibility: "internal", meta: { route: { method, path: routePath } } });
    out.complexity.set(idx, complexityOf(last));
  }

  // Exports of declared symbols
  for (const s of out.symbols) if (s.exported) out.exports.push(s.name);
  for (const e of exportedNames) if (e && !out.exports.includes(e)) out.exports.push(e);

  // Calls
  for (const call of scan.of("call_expression", "new_expression")) {
    const fn = call.type === "new_expression" ? call.childForFieldName("constructor") : call.childForFieldName("function");
    if (!fn) continue;
    let callee = fn.text;
    if (fn.type === "member_expression") callee = fn.childForFieldName("property")?.text ?? callee;
    if (fn.type === "import" || callee === "require") continue;
    if (!/^[A-Za-z_$#][\w$]*$/.test(callee)) continue;
    out.calls.push({ name: callee, expression: text(fn, 120), line: lineOf(call), callerIndex: enclosingSymbol(ctx, lineOf(call)), args: argsOf(call), isNew: call.type === "new_expression" });
  }
  collectIdentifierNodes(scan.of("identifier", "type_identifier", "property_identifier", "jsx_identifier"), out.identifiers);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------
function extractPython(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  const { out } = ctx;
  for (const imp of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (imp.type === "import_statement") {
      for (const d of imp.namedChildren) {
        const nm = d.type === "aliased_import" ? d.childForFieldName("name")?.text : d.text;
        if (nm) out.imports.push({ specifier: nm, names: [d.type === "aliased_import" ? (d.childForFieldName("alias")?.text ?? nm) : nm.split(".")[0]], line: lineOf(imp) });
      }
    } else {
      const mod = imp.childForFieldName("module_name")?.text ?? "";
      const names: string[] = [];
      for (const d of imp.namedChildren.slice(1)) {
        if (d.type === "dotted_name" || d.type === "identifier") names.push(d.text);
        else if (d.type === "aliased_import") names.push(d.childForFieldName("alias")?.text ?? d.childForFieldName("name")?.text ?? "");
        else if (d.type === "wildcard_import") names.push("*");
      }
      const rel = imp.namedChildren.find((c) => c.type === "relative_import");
      out.imports.push({ specifier: rel ? rel.text : mod, names: names.filter(Boolean), line: lineOf(imp) });
    }
  }
  const declTypes = ["function_definition", "class_definition"];
  walk(root, (n) => {
    if (n.type === "expression_statement" && n.parent?.type === "module") {
      const a = n.namedChildren[0];
      if (a?.type === "assignment") {
        const left = a.childForFieldName("left");
        const right = a.childForFieldName("right");
        if (left?.type === "identifier") {
          const name = left.text;
          const isConst = /^[A-Z][A-Z0-9_]+$/.test(name);
          const meta: Record<string, unknown> = {};
          let kind: SymbolKind = isConst ? "constant" : "variable";
          const rt = right?.text.slice(0, 200) ?? "";
          if (/\b(FastAPI|Flask|APIRouter|Blueprint|Celery|Sanic|Starlette|Quart|Typer|click\.Group|Bottle)\(/.test(rt)) kind = "service";
          if (/\b(Table|declarative_base|create_engine|sessionmaker|Base\s*=)/.test(rt)) kind = "model";
          if (isConst || kind !== "variable" || right?.type === "call") {
            addSymbol(ctx, { name, kind, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported: !name.startsWith("_"), visibility: name.startsWith("_") ? "private" : "public", meta: Object.keys(meta).length ? meta : undefined });
          }
        }
      }
      return false;
    }
    if (!declTypes.includes(n.type)) return;
    const name = n.childForFieldName("name")?.text;
    if (!name) return;
    const parentIdx = enclosingSymbol(ctx, lineOf(n));
    const parentSym = parentIdx !== undefined ? out.symbols[parentIdx] : undefined;
    let kind: SymbolKind = n.type === "class_definition" ? "class" : parentSym && (parentSym.kind === "class" || parentSym.kind === "model" || parentSym.kind === "service") ? "method" : "function";
    const decorators: string[] = [];
    if (n.parent?.type === "decorated_definition") for (const d of n.parent.namedChildren) if (d.type === "decorator") decorators.push(d.text.slice(0, 160));
    const params = n.childForFieldName("parameters")?.text ?? "";
    const supers = n.childForFieldName("superclasses");
    const superNames: string[] = [];
    if (supers) for (const s of supers.namedChildren) if (/identifier|attribute/.test(s.type)) superNames.push(s.text);
    if (kind === "class") {
      if (superNames.some((s) => /(models\.Model|Base|DeclarativeBase|BaseModel|Document|db\.Model|Model|Schema|TypedDict|Table)$/.test(s))) kind = superNames.some((s) => /BaseModel|TypedDict|Schema$/.test(s)) ? "schema" : "model";
      if (/\b(Service|Repository|Manager|Client|Handler|Gateway|Provider|Controller|UseCase)$/.test(name)) kind = "service";
      if (superNames.some((s) => /(TestCase|unittest\.TestCase)$/.test(s)) || /^Test/.test(name)) kind = "class";
    }
    if (decorators.some((d) => /@(app|router|api|bp|blueprint|[a-z_]+_router|[a-z_]+_bp)\.(get|post|put|patch|delete|route|api_route|websocket|head|options)\b/.test(d))) kind = "endpoint";
    if (decorators.some((d) => /@(celery|app|shared_task|task|periodic_task|scheduler|cron|huey)\b.*\.(task|periodic_task|scheduled_job|job)|@shared_task|@task\b/.test(d))) kind = "job";
    if (decorators.some((d) => /@(receiver|on_event|event_handler|listens_for|subscribe|sio\.on|socketio\.on|bot\.event|app\.on_event)\b/.test(d))) kind = "event_handler";
    if (decorators.some((d) => /@(dataclass|dataclasses\.dataclass|attr\.s|attrs\.define)\b/.test(d)) && kind === "class") kind = "schema";
    const idx = addSymbol(ctx, {
      name, kind, startLine: lineOf(n.parent?.type === "decorated_definition" ? n.parent : n), endLine: endLineOf(n), signature: `${n.type === "class_definition" ? "class" : "def"} ${name}${n.type === "class_definition" ? (supers?.text ?? "") : params}`.slice(0, 200),
      exported: !name.startsWith("_"), visibility: name.startsWith("__") && !name.endsWith("__") ? "private" : name.startsWith("_") ? "protected" : "public",
      documentation: pyDocstring(n.childForFieldName("body")), parentIndex: kind === "method" || (parentSym && kind !== "class" && kind !== "model" && kind !== "schema") ? parentIdx : undefined,
    });
    if (decorators.length) out.decorators.set(idx, decorators);
    if (n.type === "function_definition") out.complexity.set(idx, complexityOf(n));
    for (const s of superNames) out.inheritance.push({ childIndex: idx, parentName: s, kind: "EXTENDS" });
  });
  for (const s of out.symbols) if (s.exported && s.parentIndex === undefined) out.exports.push(s.name);
  const all = root.descendantsOfType("expression_statement").find((e) => e.parent?.type === "module" && /^__all__\s*=/.test(e.text));
  if (all) for (const m of all.text.matchAll(/['"]([A-Za-z_]\w*)['"]/g)) if (!out.exports.includes(m[1])) out.exports.push(m[1]);
  for (const call of root.descendantsOfType("call")) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    const callee = fn.type === "attribute" ? fn.childForFieldName("attribute")?.text ?? fn.text : fn.text;
    if (!/^[A-Za-z_]\w*$/.test(callee)) continue;
    out.calls.push({ name: callee, expression: text(fn, 120), line: lineOf(call), callerIndex: enclosingSymbol(ctx, lineOf(call)), args: argsOf(call), isNew: /^[A-Z]/.test(callee) });
  }
  collectIdentifiers(root, out.identifiers, ["identifier"]);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
function extractGo(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  const { out } = ctx;
  for (const spec of root.descendantsOfType("import_spec")) {
    const p = spec.childForFieldName("path")?.text.replace(/^"|"$/g, "") ?? "";
    const alias = spec.childForFieldName("name")?.text;
    out.imports.push({ specifier: p, names: [alias ?? p.split("/").pop() ?? p], line: lineOf(spec) });
  }
  const pkg = root.descendantsOfType("package_clause")[0]?.namedChildren[0]?.text ?? "";
  walk(root, (n) => {
    if (n.type === "function_declaration" || n.type === "method_declaration") {
      const name = n.childForFieldName("name")?.text;
      if (!name) return false;
      const recv = n.childForFieldName("receiver");
      const recvType = recv?.text.replace(/[()*]/g, "").split(/\s+/).pop();
      const exported = /^[A-Z]/.test(name);
      let kind: SymbolKind = n.type === "method_declaration" ? "method" : "function";
      const meta: Record<string, unknown> = {};
      if (name === "main" && pkg === "main") meta.entry = true;
      if (/^(Serve|Handle|Handler)/.test(name) || /http\.ResponseWriter/.test(n.childForFieldName("parameters")?.text ?? "")) kind = "endpoint";
      if (/gin\.Context|echo\.Context|fiber\.Ctx/.test(n.childForFieldName("parameters")?.text ?? "")) kind = "endpoint";
      const parentIdx = recvType ? out.symbols.find((s) => s.name === recvType && s.parentIndex === undefined)?.index : undefined;
      const idx = addSymbol(ctx, { name, kind, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported, visibility: exported ? "public" : "internal", documentation: docBefore(n), parentIndex: parentIdx, meta: { ...meta, receiver: recvType } });
      out.complexity.set(idx, complexityOf(n));
      return false;
    }
    if (n.type === "type_spec") {
      const name = n.childForFieldName("name")?.text;
      const t = n.childForFieldName("type");
      if (!name || !t) return false;
      let kind: SymbolKind = t.type === "struct_type" ? "struct" : t.type === "interface_type" ? "interface" : "type";
      const meta: Record<string, unknown> = {};
      if (t.type === "struct_type" && /`[^`]*(gorm|db|bson|json):/.test(t.text)) {
        if (/gorm:|bson:|db:/.test(t.text)) kind = "model";
        const fields: string[] = [];
        for (const f of t.descendantsOfType("field_declaration")) fields.push(f.childForFieldName("name")?.text ?? f.namedChildren[0]?.text ?? "");
        meta.fields = fields.filter(Boolean).slice(0, 60);
      }
      if (/(Service|Repository|Handler|Controller|Client|Store|Manager|Gateway)$/.test(name) && t.type === "struct_type") kind = "service";
      const exported = /^[A-Z]/.test(name);
      const idx = addSymbol(ctx, { name, kind, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported, visibility: exported ? "public" : "internal", documentation: docBefore(n.parent ?? n), meta: Object.keys(meta).length ? meta : undefined });
      if (t.type === "struct_type") for (const emb of t.descendantsOfType("field_declaration")) if (!emb.childForFieldName("name")) { const nm = emb.text.replace(/^\*/, "").split(/\s/)[0]; if (/^[A-Za-z_.]+$/.test(nm)) out.inheritance.push({ childIndex: idx, parentName: nm.split(".").pop()!, kind: "EXTENDS" }); }
      return false;
    }
    if ((n.type === "const_declaration" || n.type === "var_declaration") && n.parent?.type === "source_file") {
      for (const spec of n.descendantsOfType(["const_spec", "var_spec"])) {
        const name = spec.childForFieldName("name")?.text;
        if (!name) continue;
        addSymbol(ctx, { name, kind: n.type === "const_declaration" ? "constant" : "variable", startLine: lineOf(spec), endLine: endLineOf(spec), signature: firstLine(spec), exported: /^[A-Z]/.test(name), visibility: /^[A-Z]/.test(name) ? "public" : "internal" });
      }
      return false;
    }
  });
  for (const s of out.symbols) if (s.exported) out.exports.push(s.name);
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    const callee = fn.type === "selector_expression" ? fn.childForFieldName("field")?.text ?? fn.text : fn.text;
    if (!/^[A-Za-z_]\w*$/.test(callee)) continue;
    out.calls.push({ name: callee, expression: text(fn, 120), line: lineOf(call), callerIndex: enclosingSymbol(ctx, lineOf(call)), args: argsOf(call) });
  }
  collectIdentifiers(root, out.identifiers, ["identifier", "type_identifier", "field_identifier"]);
}

// ---------------------------------------------------------------------------
// Java / C# (similar shapes)
// ---------------------------------------------------------------------------
function extractJavaLike(ctx: Ctx, tree: Tree, lang: "Java" | "C#"): void {
  const root = tree.rootNode;
  const { out } = ctx;
  const importType = lang === "Java" ? "import_declaration" : "using_directive";
  for (const imp of root.descendantsOfType(importType)) {
    const spec = imp.text.replace(/^(import|using)\s+(static\s+)?/, "").replace(/;$/, "").trim();
    out.imports.push({ specifier: spec, names: [spec.split(".").pop() ?? spec], line: lineOf(imp) });
  }
  const typeDecls = lang === "Java"
    ? ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]
    : ["class_declaration", "interface_declaration", "enum_declaration", "struct_declaration", "record_declaration"];
  const memberDecls = lang === "Java" ? ["method_declaration", "constructor_declaration", "field_declaration"] : ["method_declaration", "constructor_declaration", "property_declaration", "field_declaration"];
  walk(root, (n) => {
    if (typeDecls.includes(n.type)) {
      const name = n.childForFieldName("name")?.text;
      if (!name) return;
      let kind: SymbolKind = n.type.startsWith("interface") ? "interface" : n.type.startsWith("enum") ? "enum" : n.type.startsWith("struct") ? "struct" : "class";
      const mods = lang === "Java" ? n.namedChildren.find((c) => c.type === "modifiers")?.text ?? "" : n.text.slice(0, 200);
      const annos = [...mods.matchAll(/@\w+(\([^)]*\))?|\[\w+(\([^)]*\))?\]/g)].map((m) => m[0]);
      if (annos.some((a) => /@(Service|Component|Repository|RestController|Controller|Configuration|Bean)\b|\[(ApiController|Route|Controller)/.test(a))) kind = "service";
      if (annos.some((a) => /@(Entity|Table|Document|MappedSuperclass)\b|\[Table/.test(a))) kind = "model";
      if (/(Service|Repository|Controller|Handler|Manager|Provider|Client|Gateway|Adapter|UseCase|Facade)$/.test(name) && kind === "class") kind = "service";
      if (lang === "C#" && /\bDbContext\b/.test(n.text.slice(0, 300))) kind = "service";
      const exported = /\bpublic\b/.test(mods) || lang === "C#";
      const parentIdx = enclosingSymbol(ctx, lineOf(n));
      const idx = addSymbol(ctx, { name, kind, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported, visibility: exported ? "public" : "internal", documentation: docBefore(n), parentIndex: parentIdx !== undefined && out.symbols[parentIdx].kind !== "namespace" ? parentIdx : undefined, meta: annos.length ? { annotations: annos } : undefined });
      if (annos.length) out.decorators.set(idx, annos);
      const sup = lang === "C#" ? undefined : n.childForFieldName("superclass") ?? n.childForFieldName("interfaces") ?? n.namedChildren.find((c) => c.type === "super_interfaces" || c.type === "superclass");
      if (sup) for (const t of sup.descendantsOfType(["type_identifier", "identifier", "generic_type", "generic_name"])) if (t.parent?.id === sup.id || t.parent?.type === "type_list") out.inheritance.push({ childIndex: idx, parentName: t.text.replace(/<.*$/, ""), kind: n.type.startsWith("interface") || sup.type === "super_interfaces" ? "IMPLEMENTS" : "EXTENDS" });
      if (lang === "C#") for (const bl of n.namedChildren.filter((c) => c.type === "base_list")) for (const t of bl.namedChildren) { const nm = t.text.replace(/<.*$/, ""); if (/^[A-Za-z_][\w.]*$/.test(nm)) out.inheritance.push({ childIndex: idx, parentName: nm, kind: /^I[A-Z]/.test(nm) ? "IMPLEMENTS" : "EXTENDS" }); }
      return;
    }
    if (n.type === "namespace_declaration" || n.type === "file_scoped_namespace_declaration") {
      const name = n.childForFieldName("name")?.text;
      if (name) addSymbol(ctx, { name, kind: "namespace", startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported: true, visibility: "public" });
      return;
    }
    if (memberDecls.includes(n.type)) {
      const parentIdx = enclosingSymbol(ctx, lineOf(n));
      let name = n.childForFieldName("name")?.text;
      if (n.type === "field_declaration") name = n.descendantsOfType("variable_declarator")[0]?.childForFieldName("name")?.text ?? n.descendantsOfType("identifier")[0]?.text;
      if (!name) return false;
      const mods = lang === "Java" ? n.namedChildren.find((c) => c.type === "modifiers")?.text ?? "" : n.text.slice(0, 200);
      const annos = [...mods.matchAll(/@\w+(\([^)]*\))?|\[\w+(\([^)]*\))?\]/g)].map((m) => m[0]);
      let kind: SymbolKind = n.type === "field_declaration" || n.type === "property_declaration" ? "property" : "method";
      if (annos.some((a) => /@(Get|Post|Put|Patch|Delete|Request)Mapping\b|\[Http(Get|Post|Put|Patch|Delete)/.test(a))) kind = "endpoint";
      if (annos.some((a) => /@(Scheduled|Cron)\b/.test(a))) kind = "job";
      if (annos.some((a) => /@(EventListener|KafkaListener|RabbitListener|JmsListener|SqsListener|Subscribe)\b/.test(a))) kind = "event_handler";
      if (kind === "property" && !/\bpublic\b/.test(mods)) return false;
      const visibility: ParsedSymbol["visibility"] = /\bprivate\b/.test(mods) ? "private" : /\bprotected\b/.test(mods) ? "protected" : /\bpublic\b/.test(mods) ? "public" : "internal";
      const idx = addSymbol(ctx, { name, kind, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported: visibility === "public", visibility, documentation: docBefore(n), parentIndex: parentIdx });
      if (annos.length) out.decorators.set(idx, annos);
      if (kind !== "property") out.complexity.set(idx, complexityOf(n));
      if (name === "Main" || name === "main") { const s = out.symbols[idx]; s.meta = { ...(s.meta ?? {}), entry: true }; }
      return false;
    }
  });
  for (const s of out.symbols) if (s.exported && (s.kind !== "method" && s.kind !== "property")) out.exports.push(s.name);
  const callType = lang === "Java" ? ["method_invocation", "object_creation_expression"] : ["invocation_expression", "object_creation_expression"];
  for (const call of root.descendantsOfType(callType)) {
    let callee: string | undefined;
    if (call.type === "method_invocation") callee = call.childForFieldName("name")?.text;
    else if (call.type === "object_creation_expression") callee = call.childForFieldName("type")?.text.replace(/<.*$/, "");
    else {
      const fn = call.childForFieldName("function");
      callee = fn?.type === "member_access_expression" ? fn.childForFieldName("name")?.text : fn?.text;
    }
    if (!callee || !/^[A-Za-z_]\w*$/.test(callee)) continue;
    out.calls.push({ name: callee, expression: text(call, 120), line: lineOf(call), callerIndex: enclosingSymbol(ctx, lineOf(call)), args: argsOf(call), isNew: call.type === "object_creation_expression" });
  }
  collectIdentifiers(root, out.identifiers, ["identifier", "type_identifier"]);
}

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------
function extractRuby(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  const { out } = ctx;
  for (const call of root.descendantsOfType("call")) {
    const m = call.childForFieldName("method")?.text;
    if (m === "require" || m === "require_relative") {
      const arg = call.childForFieldName("arguments")?.namedChildren[0]?.text.replace(/^['"]|['"]$/g, "");
      if (arg) out.imports.push({ specifier: arg, names: [arg.split("/").pop() ?? arg], line: lineOf(call) });
    }
  }
  walk(root, (n) => {
    if (n.type === "class" || n.type === "module") {
      const name = n.childForFieldName("name")?.text;
      if (!name) return;
      let kind: SymbolKind = n.type === "module" ? "namespace" : "class";
      const sup = n.childForFieldName("superclass")?.text.replace(/^<\s*/, "");
      if (sup && /ApplicationRecord|ActiveRecord::Base/.test(sup)) kind = "model";
      if (sup && /Controller$/.test(sup)) kind = "service";
      if (/Service$|Job$|Worker$|Mailer$/.test(name)) kind = /Job$|Worker$/.test(name) ? "job" : "service";
      const parentIdx = enclosingSymbol(ctx, lineOf(n));
      const idx = addSymbol(ctx, { name, kind, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported: true, visibility: "public", documentation: docBefore(n), parentIndex: parentIdx });
      if (sup) out.inheritance.push({ childIndex: idx, parentName: sup, kind: "EXTENDS" });
      for (const inc of n.descendantsOfType("call")) if (/^(include|extend)$/.test(inc.childForFieldName("method")?.text ?? "") && inc.parent?.parent?.id === n.id) { const arg = inc.childForFieldName("arguments")?.text; if (arg) out.inheritance.push({ childIndex: idx, parentName: arg, kind: "IMPLEMENTS" }); }
      return;
    }
    if (n.type === "method" || n.type === "singleton_method") {
      const name = n.childForFieldName("name")?.text;
      if (!name) return false;
      const parentIdx = enclosingSymbol(ctx, lineOf(n));
      const parentSym = parentIdx !== undefined ? out.symbols[parentIdx] : undefined;
      const kind: SymbolKind = parentSym?.kind === "service" && /Controller/.test(parentSym.signature ?? "") ? "endpoint" : parentIdx !== undefined ? "method" : "function";
      const idx = addSymbol(ctx, { name, kind, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported: true, visibility: "public", documentation: docBefore(n), parentIndex: parentIdx });
      out.complexity.set(idx, complexityOf(n));
      return false;
    }
  });
  for (const s of out.symbols) if (s.parentIndex === undefined) out.exports.push(s.name);
  for (const call of root.descendantsOfType("call")) {
    const m = call.childForFieldName("method")?.text;
    if (!m || !/^[A-Za-z_]\w*[?!]?$/.test(m)) continue;
    out.calls.push({ name: m.replace(/[?!]$/, ""), expression: text(call, 120), line: lineOf(call), callerIndex: enclosingSymbol(ctx, lineOf(call)), args: argsOf(call), isNew: m === "new" });
  }
  collectIdentifiers(root, out.identifiers, ["identifier", "constant"]);
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------
function extractRust(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  const { out } = ctx;
  for (const u of root.descendantsOfType("use_declaration")) {
    const spec = u.text.replace(/^use\s+/, "").replace(/;$/, "");
    out.imports.push({ specifier: spec.split("::")[0], names: [...spec.matchAll(/([A-Za-z_]\w*)\s*(?:,|\}|$)/g)].map((m) => m[1]).slice(0, 20), line: lineOf(u) });
  }
  walk(root, (n) => {
    const map: Record<string, SymbolKind> = { function_item: "function", struct_item: "struct", enum_item: "enum", trait_item: "trait", type_item: "type", const_item: "constant", static_item: "variable", mod_item: "module", function_signature_item: "method" };
    if (n.type === "impl_item") {
      const t = n.childForFieldName("type")?.text.replace(/<.*$/, "");
      const trait = n.childForFieldName("trait")?.text.replace(/<.*$/, "");
      const target = t ? out.symbols.find((s) => s.name === t && s.parentIndex === undefined) : undefined;
      if (target && trait) out.inheritance.push({ childIndex: target.index, parentName: trait, kind: "IMPLEMENTS" });
      for (const f of n.descendantsOfType("function_item")) {
        const name = f.childForFieldName("name")?.text;
        if (!name) continue;
        const idx = addSymbol(ctx, { name, kind: "method", startLine: lineOf(f), endLine: endLineOf(f), signature: firstLine(f), exported: /^pub\b/.test(f.text), visibility: /^pub\b/.test(f.text) ? "public" : "internal", documentation: docBefore(f), parentIndex: target?.index, qualifiedName: target ? `${target.name}::${name}` : `${t ?? "impl"}::${name}` });
        out.complexity.set(idx, complexityOf(f));
      }
      return false;
    }
    const kind = map[n.type];
    if (!kind) return;
    const name = n.childForFieldName("name")?.text;
    if (!name) return;
    const exported = /^pub\b/.test(n.text);
    const attrs: string[] = [];
    let prev = n.previousNamedSibling;
    while (prev && prev.type === "attribute_item") { attrs.unshift(prev.text.slice(0, 120)); prev = prev.previousNamedSibling; }
    let k = kind;
    if (attrs.some((a) => /derive\([^)]*(Serialize|Deserialize|Queryable|Insertable|Table)/.test(a)) && k === "struct") k = "schema";
    if (attrs.some((a) => /#\[(get|post|put|delete|patch|route|handler|actix_web::(get|post))/.test(a))) k = "endpoint";
    if (name === "main" && k === "function") { /* entry */ }
    const idx = addSymbol(ctx, { name, kind: k, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported, visibility: exported ? "public" : "internal", documentation: docBefore(n), meta: name === "main" ? { entry: true } : undefined });
    if (attrs.length) out.decorators.set(idx, attrs);
    if (k === "function" || k === "endpoint") out.complexity.set(idx, complexityOf(n));
    return k === "module" ? undefined : false;
  });
  for (const s of out.symbols) if (s.exported) out.exports.push(s.name);
  for (const call of root.descendantsOfType(["call_expression", "macro_invocation"])) {
    const fn = call.type === "macro_invocation" ? call.childForFieldName("macro") : call.childForFieldName("function");
    if (!fn) continue;
    const callee = fn.text.split("::").pop()?.split(".").pop() ?? "";
    if (!/^[A-Za-z_]\w*$/.test(callee)) continue;
    out.calls.push({ name: callee, expression: text(fn, 120), line: lineOf(call), callerIndex: enclosingSymbol(ctx, lineOf(call)), args: argsOf(call) });
  }
  collectIdentifiers(root, out.identifiers, ["identifier", "type_identifier", "field_identifier"]);
}

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------
function extractPhp(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  const { out } = ctx;
  for (const u of root.descendantsOfType("namespace_use_declaration")) {
    for (const c of u.descendantsOfType("namespace_use_clause")) out.imports.push({ specifier: c.text.split(" as ")[0], names: [c.text.split("\\").pop()?.split(" as ").pop() ?? c.text], line: lineOf(u) });
  }
  for (const inc of root.descendantsOfType(["require_expression", "require_once_expression", "include_expression", "include_once_expression"])) {
    const arg = inc.namedChildren[0]?.text.replace(/^['"]|['"]$/g, "");
    if (arg) out.imports.push({ specifier: arg, names: [], line: lineOf(inc) });
  }
  walk(root, (n) => {
    const map: Record<string, SymbolKind> = { function_definition: "function", class_declaration: "class", interface_declaration: "interface", trait_declaration: "trait", enum_declaration: "enum", method_declaration: "method" };
    const kind = map[n.type];
    if (!kind) return;
    const name = n.childForFieldName("name")?.text;
    if (!name) return;
    const parentIdx = enclosingSymbol(ctx, lineOf(n));
    let k = kind;
    if (k === "class") {
      if (/(Controller)$/.test(name)) k = "service";
      if (/(Service|Repository|Manager|Provider|Handler|Job|Listener)$/.test(name)) k = /Job$/.test(name) ? "job" : /Listener$/.test(name) ? "event_handler" : "service";
      if (/extends\s+(Model|Eloquent|Authenticatable)\b/.test(n.text.slice(0, 300))) k = "model";
    }
    const mods = n.text.slice(0, 80);
    const visibility: ParsedSymbol["visibility"] = /\bprivate\b/.test(mods) ? "private" : /\bprotected\b/.test(mods) ? "protected" : "public";
    const idx = addSymbol(ctx, { name, kind: k, startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported: visibility === "public", visibility, documentation: docBefore(n), parentIndex: kind === "method" ? parentIdx : undefined });
    if (k !== "class" && k !== "interface" && k !== "trait" && k !== "enum") out.complexity.set(idx, complexityOf(n));
    const base = n.childForFieldName("base_clause") ?? n.namedChildren.find((c) => c.type === "base_clause");
    if (base) for (const t of base.namedChildren) out.inheritance.push({ childIndex: idx, parentName: t.text.split("\\").pop()!, kind: "EXTENDS" });
    const impl = n.namedChildren.find((c) => c.type === "class_interface_clause");
    if (impl) for (const t of impl.namedChildren) out.inheritance.push({ childIndex: idx, parentName: t.text.split("\\").pop()!, kind: "IMPLEMENTS" });
  });
  for (const s of out.symbols) if (s.parentIndex === undefined) out.exports.push(s.name);
  for (const call of root.descendantsOfType(["function_call_expression", "member_call_expression", "scoped_call_expression", "object_creation_expression"])) {
    let callee = call.childForFieldName("name")?.text ?? call.childForFieldName("function")?.text ?? call.namedChildren[0]?.text ?? "";
    callee = callee.split("\\").pop() ?? callee;
    if (!/^[A-Za-z_]\w*$/.test(callee)) continue;
    out.calls.push({ name: callee, expression: text(call, 120), line: lineOf(call), callerIndex: enclosingSymbol(ctx, lineOf(call)), args: argsOf(call), isNew: call.type === "object_creation_expression" });
  }
  collectIdentifiers(root, out.identifiers, ["name", "variable_name"]);
}

// ---------------------------------------------------------------------------
// CSS / HTML / JSON / Shell: light structural extraction
// ---------------------------------------------------------------------------
function extractCss(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  for (const imp of root.descendantsOfType("import_statement")) {
    const s = imp.text.match(/['"]([^'"]+)['"]|url\(([^)]+)\)/);
    if (s) ctx.out.imports.push({ specifier: (s[1] ?? s[2]).replace(/['"]/g, ""), names: [], line: lineOf(imp) });
  }
  const seen = new Set<string>();
  for (const rule of root.descendantsOfType("rule_set")) {
    const sel = rule.childForFieldName("selectors")?.text ?? rule.namedChildren[0]?.text ?? "";
    const classNames = [...sel.matchAll(/\.([A-Za-z_-][\w-]*)/g)].map((m) => m[1]);
    for (const c of classNames.slice(0, 3)) if (!seen.has(c) && seen.size < 200) { seen.add(c); ctx.out.identifiers.add(c); }
  }
  ctx.out.exports = [...seen].slice(0, 100);
}

function extractHtml(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  for (const el of root.descendantsOfType("element")) {
    const start = el.namedChildren[0];
    const tag = start?.namedChildren[0]?.text;
    if (tag !== "script" && tag !== "link") continue;
    const attrs = start?.text ?? "";
    const m = attrs.match(/(?:src|href)=["']([^"']+)["']/);
    if (m) ctx.out.imports.push({ specifier: m[1], names: [], line: lineOf(el) });
  }
  for (const m of ctx.src.matchAll(/\bid=["']([A-Za-z_][\w-]*)["']/g)) ctx.out.identifiers.add(m[1]);
}

function extractJson(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  const obj = root.namedChildren[0];
  if (obj?.type !== "object") return;
  for (const pair of obj.namedChildren.filter((c) => c.type === "pair")) {
    const key = pair.childForFieldName("key")?.text.replace(/^"|"$/g, "");
    if (key) ctx.out.identifiers.add(key);
  }
}

function extractShell(ctx: Ctx, tree: Tree): void {
  const root = tree.rootNode;
  walk(root, (n) => {
    if (n.type === "function_definition") {
      const name = n.childForFieldName("name")?.text;
      if (name) { const idx = addSymbol(ctx, { name, kind: "function", startLine: lineOf(n), endLine: endLineOf(n), signature: firstLine(n), exported: true, visibility: "public" }); ctx.out.complexity.set(idx, complexityOf(n)); }
      return false;
    }
  });
  for (const cmd of root.descendantsOfType("command")) {
    const name = cmd.childForFieldName("name")?.text;
    if (name && /^[A-Za-z_][\w.-]*$/.test(name)) ctx.out.calls.push({ name, expression: text(cmd, 120), line: lineOf(cmd), callerIndex: enclosingSymbol(ctx, lineOf(cmd)) });
    if (name === "source" || name === ".") { const arg = cmd.namedChildren[1]?.text; if (arg) ctx.out.imports.push({ specifier: arg, names: [], line: lineOf(cmd) }); }
  }
}

export function extractFromTree(language: string, grammarKey: string, tree: Tree, src: string, filePath: string): ParsedFile {
  const out = emptyParse("ast", `tree-sitter:${grammarKey}`);
  const ctx: Ctx = { src, out, language, filePath };
  switch (language) {
    case "TypeScript": case "JavaScript": extractTsJs(ctx, tree); break;
    case "Python": extractPython(ctx, tree); break;
    case "Go": extractGo(ctx, tree); break;
    case "Java": extractJavaLike(ctx, tree, "Java"); break;
    case "C#": extractJavaLike(ctx, tree, "C#"); break;
    case "Ruby": extractRuby(ctx, tree); break;
    case "Rust": extractRust(ctx, tree); break;
    case "PHP": extractPhp(ctx, tree); break;
    case "CSS": extractCss(ctx, tree); break;
    case "HTML": extractHtml(ctx, tree); break;
    case "JSON": extractJson(ctx, tree); break;
    case "Shell": extractShell(ctx, tree); break;
    default: out.status = "text";
  }
  if (tree.rootNode.hasError) out.error = SYNTAX_WARNING;
  return out;
}
