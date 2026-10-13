#!/usr/bin/env node
/**
 * Render site/social/card.html to the link-preview JPEG and the GitHub
 * Social preview PNG. Uses Playwright (the project's devDependency) and
 * falls back to an installed Google Chrome.
 *
 *   node site/render-social.mjs
 *
 * Writes site/media/og.jpg (1200×630) and docs/brand/social-preview.png
 * (1280×640). Both stay under 300KB. The site build copies og.jpg into
 * site/dist; it does not re-render, so run this after editing the card.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(siteDir);
const cardPath = join(siteDir, "social", "card.html");
const maxBytes = 300 * 1024;

const targets = [
  { width: 1200, height: 630, type: "jpeg", path: join(siteDir, "media", "og.jpg") },
  { width: 1280, height: 640, type: "png", path: join(root, "docs", "brand", "social-preview.png") },
];

export async function renderSocialCards() {
  const chromium = await loadChromium();
  const browser = await launch(chromium);
  try {
    for (const target of targets) {
      const page = await browser.newPage({
        viewport: { width: target.width, height: target.height },
        deviceScaleFactor: 1,
      });
      await page.goto(pathToFileURL(cardPath).href, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
        const failed = [...document.fonts].filter((face) => face.status !== "loaded");
        if (failed.length) {
          throw new Error(failed.map((face) => `${face.family} ${face.status}`).join(", "));
        }
        const shot = document.querySelector(".shot img");
        if (shot && !shot.complete) {
          await new Promise((resolve, reject) => {
            shot.addEventListener("load", resolve, { once: true });
            shot.addEventListener("error", () => reject(new Error("review screenshot did not load")), { once: true });
          });
        }
        if (shot && shot.naturalWidth === 0) throw new Error("review screenshot did not load");
      });
      const bytes = target.type === "jpeg" ? await jpegUnderBudget(page, target) : await pngUnderBudget(page, target);
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, bytes);
      const { width, height } = imageSize(bytes);
      if (width !== target.width || height !== target.height) {
        throw new Error(`${target.path} rendered at ${width}×${height}, expected ${target.width}×${target.height}`);
      }
      if (bytes.length > maxBytes) {
        throw new Error(`${target.path} is ${bytes.length} bytes, over the 300KB budget`);
      }
      console.log(`${target.path} ${width}×${height} ${(bytes.length / 1024).toFixed(0)}KB`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function jpegUnderBudget(page, target) {
  let quality = 82;
  let bytes = await page.screenshot({ type: "jpeg", quality, clip: clip(target) });
  while (bytes.length > maxBytes && quality > 58) {
    quality -= 6;
    bytes = await page.screenshot({ type: "jpeg", quality, clip: clip(target) });
  }
  return bytes;
}

async function pngUnderBudget(page, target) {
  const raw = await page.screenshot({ type: "png", clip: clip(target) });
  if (raw.length <= maxBytes) return raw;
  const dir = mkdtempSync(join(tmpdir(), "brody-social-"));
  try {
    const src = join(dir, "in.png");
    const out = join(dir, "out.png");
    writeFileSync(src, raw);
    const quant = spawnSync("pngquant", ["--quality=68-92", "--speed", "1", "--force", "--output", out, src], { encoding: "utf8" });
    if (quant.status === 0) {
      const bytes = readFileSync(out);
      if (bytes.length <= maxBytes) return bytes;
    }
    return raw;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function clip(target) {
  return { x: 0, y: 0, width: target.width, height: target.height };
}

function isFileSpecifier(spec) {
  return spec.startsWith(".") || spec.startsWith("/") || spec.includes("\\") || /^[A-Za-z]:[\\/]/.test(spec) || existsSync(spec);
}

async function loadChromium() {
  const specs = [process.env.PLAYWRIGHT_CORE, "playwright", "playwright-core"].filter(Boolean);
  const errors = [];
  for (const spec of specs) {
    try {
      const mod = isFileSpecifier(spec)
        ? await import(pathToFileURL(spec).href)
        : await import(spec);
      if (mod.chromium) return mod.chromium;
      errors.push(`${spec} has no chromium export`);
    } catch (error) {
      errors.push(`${spec}: ${error.message}`);
    }
  }
  throw new Error(`Playwright is not installed.\n${errors.join("\n")}\nInstall it with npm install, then npx playwright install chromium.`);
}

async function launch(chromium) {
  const args = ["--disable-dev-shm-usage", "--force-color-profile=srgb", "--allow-file-access-from-files"];
  try {
    return await chromium.launch({ args });
  } catch {
    return await chromium.launch({ channel: "chrome", args });
  }
}

function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a png or jpeg");
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
  throw new Error("jpeg has no size marker");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  renderSocialCards().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
