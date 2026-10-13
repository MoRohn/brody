#!/usr/bin/env node
/**
 * Assemble the GitHub Pages site into site/dist.
 * This does not run the Next.js app build. Screenshots are resized from
 * docs/screenshots with ffmpeg when it is on PATH; otherwise the original
 * PNGs are copied and the page's image URLs are rewritten to match.
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

const review = join(shots, "review.png");
if (hasWebp) {
  run("ffmpeg", ["-y", "-i", review, "-vf", "scale=-2:630,pad=1200:630:(ow-iw)/2:(oh-ih)/2:color=0x15283a", "-q:v", "3", join(dist, "media", "og.jpg")]);
} else {
  cpSync(review, join(dist, "media", "og.png"));
  html = html.replaceAll("media/og.jpg", "media/og.png");
  html = html.replaceAll(".webp", ".png");
}

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
  "http://localhost:3003",
  "npm run analyze -- ./path/to/project --out ./report",
  "fixtures/sample-shop",
  "MIT License",
  "Rohn Springfield",
  "never executed",
  "Lean 4",
  "https://morohn.github.io/brody/",
  "https://github.com/MoRohn/brody",
  "Node 24",
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

function fail(message) {
  console.error(message);
  process.exit(1);
}
