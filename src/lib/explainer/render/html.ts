/**
 * The HTML renderer. A scene is drawn by the same frame function the interactive player uses in the browser
 * (frame.ts → SVG), rasterised here with resvg using the exact font files the layout was measured with, and streamed as
 * raw frames into FFmpeg. Deterministic: frame i is the SVG at exactly i / fps seconds, so there is no clock to drift.
 */
import fs from "node:fs";
import path from "node:path";
import { renderFrameSvg } from "../frame";
import { encodeRgbaFrames } from "../media";
import { fontFiles } from "../measure";
import type { SceneSpec } from "../types";
import type { ExplainerRenderer, RenderContext, SceneRender } from "./types";

type ResvgModule = typeof import("@resvg/resvg-js");
let resvg: ResvgModule | null | undefined;
async function loadResvg(): Promise<ResvgModule | null> {
  if (resvg !== undefined) return resvg;
  try { resvg = await import("@resvg/resvg-js"); } catch { resvg = null; }
  return resvg;
}

export class HtmlRenderer implements ExplainerRenderer {
  readonly id = "html" as const;
  readonly label = "HTML/SVG renderer (resvg)";

  async unavailableReason(): Promise<string | null> {
    return (await loadResvg()) ? null : "The @resvg/resvg-js package is not installed.";
  }

  /** Rasterise one frame to RGBA (also used for storyboards and visual checks). */
  async rasterize(scene: SceneSpec, localMs: number, ctx: Pick<RenderContext, "style" | "width" | "height">): Promise<{ rgba: Buffer; png: () => Buffer }> {
    const r = await loadResvg();
    if (!r) throw new Error("resvg is not available");
    const svg = renderFrameSvg(scene, localMs, { style: ctx.style, width: ctx.width, height: ctx.height });
    const img = new r.Resvg(svg, { font: { fontFiles: fontFiles(), loadSystemFonts: false, defaultFontFamily: "DejaVu Sans Condensed" }, fitTo: { mode: "width", value: ctx.width } }).render();
    return { rgba: Buffer.from(img.pixels), png: () => Buffer.from(img.asPng()) };
  }

  async renderScene(scene: SceneSpec, ctx: RenderContext): Promise<SceneRender> {
    const t0 = Date.now();
    const cpu0 = process.cpuUsage();
    fs.mkdirSync(ctx.workDir, { recursive: true });
    const sceneJson = path.join(ctx.workDir, "scene.json");
    fs.writeFileSync(sceneJson, JSON.stringify(scene));
    const video = path.join(ctx.workDir, "html.mp4");
    let lastPct = -1;
    await encodeRgbaFrames(video, { width: ctx.width, height: ctx.height }, ctx.fps, scene.frameCount, async (i) => {
      if (ctx.signal?.aborted) throw new Error("Rendering was cancelled.");
      const pct = Math.floor((i / scene.frameCount) * 20);
      if (pct !== lastPct) { lastPct = pct; ctx.onProgress?.(i / scene.frameCount); }
      // Yield now and then so a long render never starves the web server's event loop.
      if (i % 15 === 0) await new Promise((r) => setImmediate(r));
      return (await this.rasterize(scene, (i * 1000) / ctx.fps, ctx)).rgba;
    }, { signal: ctx.signal });
    const cpu = process.cpuUsage(cpu0);
    return { video, sources: [sceneJson], renderer: "html", ms: Date.now() - t0, cpuMs: Math.round((cpu.user + cpu.system) / 1000) };
  }
}
