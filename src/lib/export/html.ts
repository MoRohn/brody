import { escapeHtml } from "../util/text";

function inline(s: string): string {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, "$1<em>$2</em>");
  return t;
}

/** Converts the report's own Markdown subset (headings, tables, fences, lists, paragraphs) to HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  let list: "ul" | "ol" | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  while (i < lines.length) {
    const line = lines[i];
    const fenceM = line.match(/^```(\w*)/);
    if (fenceM) {
      closeList();
      const lang = fenceM[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      const code = body.join("\n");
      out.push(lang === "mermaid" ? `<pre class="mermaid">${escapeHtml(code)}</pre>` : `<pre><code${lang ? ` class="lang-${lang}"` : ""}>${escapeHtml(code)}</code></pre>`);
      continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) { closeList(); out.push(`<h${hm[1].length} id="${slug(hm[2])}">${inline(hm[2])}</h${hm[1].length}>`); i++; continue; }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|\s*:?-{2,}/.test(lines[i + 1])) {
      closeList();
      const head = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|"));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i].split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, "|"))); i++; }
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      i++;
      continue;
    }
    if (line.trim() === "") { closeList(); i++; continue; }
    closeList();
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\|.*\||\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  closeList();
  return out.join("\n");
}

/** Diagram rendering is optional: if the library fails to start, the Mermaid source stays readable as text. */
const MERMAID_ONLOAD = "try{mermaid.initialize({startOnLoad:true,theme:window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'default'})}catch(_e){/*diagrams stay as source text*/}";

export function buildHtmlDocument(title: string, markdown: string, opts: { print?: boolean } = {}): string {
  const body = markdownToHtml(markdown);
  const toc = [...markdown.matchAll(/^## (\d+\..*)$/gm)].map((m) => `<li><a href="#${m[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}">${escapeHtml(m[1])}</a></li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#fff;--fg:#0a1a26;--muted:#3d5265;--line:#c4d5e0;--code:#eaf1f5;--accent:#006c96;--deep:#1b4965}
@media (prefers-color-scheme:dark){:root{--bg:#0f202d;--fg:#e4eff6;--muted:#a4bccd;--line:#223a4c;--code:#162c3c;--accent:#7ccbee;--deep:#cfe8f5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{display:grid;grid-template-columns:260px minmax(0,1fr);gap:32px;max-width:1280px;margin:0 auto;padding:24px 20px}
nav{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto;font-size:13px}nav ul{list-style:none;margin:0;padding:0}nav li{margin:4px 0}nav a{color:var(--muted);text-decoration:none}nav a:hover{color:var(--accent)}
main{min-width:0}h1{font-size:28px;margin:0 0 4px;color:var(--deep)}a{color:var(--accent)}h2{color:var(--deep);font-size:21px;margin:40px 0 12px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:17px;margin:28px 0 8px}h4{font-size:15px;margin:22px 0 6px}
code{background:var(--code);padding:1px 5px;border-radius:4px;font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}pre{background:var(--code);padding:12px 14px;border-radius:6px;overflow:auto;border:1px solid var(--line)}pre code{background:none;padding:0}
.table-wrap{overflow:auto;margin:10px 0}table{border-collapse:collapse;font-size:13px;width:100%}th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}th{background:var(--code)}
pre.mermaid{background:transparent;border:1px dashed var(--line);white-space:pre;font:12px ui-monospace,monospace}
@media (max-width:860px){.wrap{grid-template-columns:1fr}nav{position:static;max-height:none}}
@media print{nav{display:none}.wrap{display:block;max-width:none;padding:0}body{font-size:11px}h2{break-before:auto}pre,table{break-inside:avoid}a{color:inherit;text-decoration:none}}
</style></head><body><div class="wrap"><nav aria-label="Report sections"><strong>Sections</strong><ul>${toc}</ul></nav><main>${body}</main></div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" onload="${MERMAID_ONLOAD}"></script>
${opts.print ? "<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),600))</script>" : ""}
</body></html>`;
}
