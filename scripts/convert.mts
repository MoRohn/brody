/**
 * Convert a Markdown file to PDF and Word using the same renderers as the app.
 *   npm run convert -- path/to/file.md [--out dir]
 */
import fs from "node:fs";
import path from "node:path";
import { parseReport } from "../src/lib/export/document";
import { renderDocx } from "../src/lib/export/docx";
import { renderPdf } from "../src/lib/export/pdf";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
if (!input || !fs.existsSync(input)) { console.error("Usage: npm run convert -- <file.md> [--out <dir>]"); process.exit(2); }
const outIdx = args.indexOf("--out");
const out = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.dirname(input));
fs.mkdirSync(out, { recursive: true });
const doc = parseReport(fs.readFileSync(input, "utf8"));
const stem = path.basename(input, path.extname(input));
const meta = { footer: doc.title, author: "Brody" };
fs.writeFileSync(path.join(out, `${stem}.pdf`), await renderPdf(doc, meta));
fs.writeFileSync(path.join(out, `${stem}.docx`), await renderDocx(doc, meta));
console.log(`Wrote ${stem}.pdf and ${stem}.docx to ${out}`);
