import { marked, type Token, type Tokens } from "marked";

/** A styled run of inline text. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export type Block =
  | { type: "heading"; level: number; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; ordered: boolean; items: Block[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; header: Run[][]; rows: Run[][][] }
  | { type: "quote"; blocks: Block[] }
  | { type: "rule" }
  | { type: "note"; text: string };

export interface ReportDocument {
  title: string;
  subtitle: string[];
  blocks: Block[];
}

function runs(tokens: Token[] | undefined, style: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong": out.push(...runs((t as Tokens.Strong).tokens, { ...style, bold: true })); break;
      case "em": out.push(...runs((t as Tokens.Em).tokens, { ...style, italic: true })); break;
      case "codespan": out.push({ ...style, code: true, text: unescape((t as Tokens.Codespan).text) }); break;
      case "link": out.push(...runs((t as Tokens.Link).tokens, { ...style, href: (t as Tokens.Link).href })); break;
      case "br": out.push({ ...style, text: "\n" }); break;
      case "del": out.push(...runs((t as Tokens.Del).tokens, style)); break;
      case "escape": out.push({ ...style, text: (t as Tokens.Escape).text }); break;
      case "image": out.push({ ...style, text: (t as Tokens.Image).text }); break;
      case "html": break;
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...runs(tt.tokens, style));
        else out.push({ ...style, text: unescape(tt.text) });
        break;
      }
      default: {
        const raw = (t as { raw?: string; text?: string }).text ?? (t as { raw?: string }).raw ?? "";
        if (raw) out.push({ ...style, text: unescape(raw) });
      }
    }
  }
  // Merge adjacent runs with identical styling.
  const merged: Run[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && !!last.code === !!r.code && last.href === r.href) last.text += r.text;
    else merged.push({ ...r });
  }
  return merged;
}

function unescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function blocks(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "heading": out.push({ type: "heading", level: (t as Tokens.Heading).depth, runs: runs((t as Tokens.Heading).tokens) }); break;
      case "paragraph": out.push({ type: "paragraph", runs: runs((t as Tokens.Paragraph).tokens) }); break;
      case "text": out.push({ type: "paragraph", runs: runs([t]) }); break;
      case "code": {
        const c = t as Tokens.Code;
        // Interactive diagrams cannot be drawn in a static document; the ASCII maps and tables carry the same information.
        if ((c.lang ?? "").startsWith("mermaid")) out.push({ type: "note", text: "Diagram omitted here. Open the Code Map in the app, or the Markdown export, for the Mermaid source." });
        else out.push({ type: "code", lang: c.lang ?? "", text: c.text });
        break;
      }
      case "list": {
        const l = t as Tokens.List;
        out.push({ type: "list", ordered: l.ordered, items: l.items.map((it) => blocks(it.tokens)) });
        break;
      }
      case "table": {
        const tb = t as Tokens.Table;
        out.push({ type: "table", header: tb.header.map((c) => runs(c.tokens)), rows: tb.rows.map((r) => r.map((c) => runs(c.tokens))) });
        break;
      }
      case "blockquote": out.push({ type: "quote", blocks: blocks((t as Tokens.Blockquote).tokens) }); break;
      case "hr": out.push({ type: "rule" }); break;
      default: break;
    }
  }
  return out;
}

/** Parse the report Markdown into a format-neutral document that the PDF and DOCX renderers share. */
export function parseReport(markdown: string): ReportDocument {
  const all = blocks(marked.lexer(markdown));
  const first = all[0];
  const title = first?.type === "heading" && first.level === 1 ? first.runs.map((r) => r.text).join("") : "Report";
  const rest = first?.type === "heading" && first.level === 1 ? all.slice(1) : all;
  // The paragraph directly under the title carries repository, branch and generation details.
  const subtitle: string[] = [];
  let i = 0;
  while (i < rest.length && rest[i].type === "paragraph" && subtitle.length < 3) {
    const p = rest[i] as Extract<Block, { type: "paragraph" }>;
    subtitle.push(...p.runs.map((r) => r.text).join("").split("\n").map((x) => x.trim()).filter(Boolean));
    i++;
    break;
  }
  return { title, subtitle, blocks: rest.slice(i) };
}

export const plain = (rs: Run[]): string => rs.map((r) => r.text).join("");

/** The level-2 headings, used for the contents list. */
export function outline(doc: ReportDocument): string[] {
  return doc.blocks.filter((b): b is Extract<Block, { type: "heading" }> => b.type === "heading" && b.level === 2).map((b) => plain(b.runs));
}
