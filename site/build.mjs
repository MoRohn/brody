#!/usr/bin/env node
/**
 * Assemble the GitHub Pages site into site/dist.
 * This does not run the Next.js app build. Screenshots are resized from
 * docs/screenshots with ffmpeg when it is on PATH; otherwise the original
 * PNGs are copied and the page's image URLs are rewritten to match.
 * The link-preview image is the committed site/media/og.jpg, rendered from
 * site/social/card.html by site/render-social.mjs.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(siteDir);
const dist = join(siteDir, "dist");
const shots = join(root, "docs", "screenshots");
const siteUrl = "https://morohn.github.io/brody/";

const ffmpeg = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
const hasWebp = ffmpeg.status === 0 && /libwebp/.test(`${ffmpeg.stdout}\n${ffmpeg.stderr}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "media"), { recursive: true });
mkdirSync(join(dist, "fonts"), { recursive: true });

let html = readFileSync(join(siteDir, "index.html"), "utf8");
const referenced = [...html.matchAll(/media\/([a-z0-9-]+)\.webp/g)].map((m) => m[1]);
const unique = [...new Set(referenced)];
if (unique.length === 0) fail("index.html does not reference any screenshots");

for (const name of unique) {
  if (name === "og") continue;
  const src = join(shots, `${name}.png`);
  try { statSync(src); } catch { fail(`missing screenshot docs/screenshots/${name}.png`); }
  if (hasWebp) {
    run("ffmpeg", ["-y", "-i", src, "-vf", "scale='min(1600,iw)':-2", "-c:v", "libwebp", "-quality", "78", join(dist, "media", `${name}.webp`)]);
  } else {
    cpSync(src, join(dist, "media", `${name}.png`));
  }
}

if (!hasWebp) html = html.replaceAll(".webp", ".png");

const og = join(siteDir, "media", "og.jpg");
const social = join(root, "docs", "brand", "social-preview.png");
cpSync(og, join(dist, "media", "og.jpg"));
assertImage(og, 1200, 630, "link preview");
assertImage(social, 1280, 640, "GitHub social preview");

for (const file of ["styles.css", "site.js", "favicon.svg"]) {
  cpSync(join(siteDir, file), join(dist, file));
}
for (const font of readdirSync(join(siteDir, "fonts"))) {
  cpSync(join(siteDir, "fonts", font), join(dist, "fonts", font));
}
cpSync(join(root, "LICENSE"), join(dist, "LICENSE.txt"));

writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`);
writeFileSync(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${siteUrl}</loc></url>
</urlset>
`);
writeFileSync(join(dist, "index.html"), html);

const required = [
  "docker compose up --build",
  "npm install",
  "npm run dev",
  "http://brody.localhost",
  "npm run analyze -- ./path/to/project --out ./report",
  "fixtures/sample-shop",
  "MIT License",
  "Rohn Springfield",
  "never executed",
  "Lean 4",
  "https://morohn.github.io/brody/",
  "https://github.com/MoRohn/brody",
  "Node 24",
  'property="og:image:width" content="1200"',
  'property="og:image:height" content="630"',
  "Evidence-backed review, Lean 4 proofs, code maps, and live AI cost.",
];
for (const phrase of required) {
  if (!html.includes(phrase)) fail(`built page is missing ${JSON.stringify(phrase)}`);
}

const built = readFileSync(join(dist, "index.html"), "utf8");
const css = readFileSync(join(dist, "styles.css"), "utf8");
const refs = new Set();
for (const match of built.matchAll(/(?:src|href)="([^"]+)"/g)) refs.add(match[1]);
for (const match of css.matchAll(/url\("([^"]+)"\)/g)) refs.add(match[1]);
for (const ref of refs) {
  if (/^(https?:|mailto:|#|data:)/.test(ref)) continue;
  const path = join(dist, ref.split("?")[0]);
  try { statSync(path); } catch { fail(`built site links to missing file ${ref}`); }
}

const bytes = statSync(join(dist, "index.html")).size;
console.log(`site built at ${relative(root, dist)} (${hasWebp ? "webp" : "png fallback"}, index.html ${bytes} bytes)`);

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`${cmd} failed\n${result.stderr || result.stdout || ""}`);
  }
}

function assertImage(path, width, height, label) {
  let buf;
  try { buf = readFileSync(path); } catch { fail(`missing ${label}: ${path}`); }
  const size = imageSize(buf);
  if (size.width !== width || size.height !== height) {
    fail(`${label} is ${size.width}×${size.height}, expected ${width}×${height} (${path})`);
  }
  const max = 300 * 1024;
  if (buf.length > max) fail(`${label} is ${buf.length} bytes; keep it under 300KB (${path})`);
}

function imageSize(buf) {
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) fail("social image is not a png or jpeg");
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  fail("jpeg is missing its size marker");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
