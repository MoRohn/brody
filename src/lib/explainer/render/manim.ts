/**
 * The Manim renderer: the scene interpreter (manim-script.ts) runs under the configured Python with Manim installed,
 * always with --disable_caching, on a render model that carries every measured text width, so Manim places text exactly
 * where the layout measured it. Output is then conformed to the scene's exact frame count by the pipeline.
 */
import fs from "node:fs";
import path from "node:path";
import { explainerConfig } from "../config";
import { PALETTES } from "../design";
import { GLYPHS } from "../glyphs";
import { lastLines, run, safeEnv } from "../media";
import { fontFiles, textWidth } from "../measure";
import type { SceneSpec, VisualObject } from "../types";
import { MANIM_SCRIPT, MANIM_SCRIPT_VERSION } from "./manim-script";
import type { ExplainerRenderer, RenderContext, SceneRender } from "./types";

let probe: { at: number; reason: string | null; version?: string } | undefined;

const mix = (a: string, b: string, p: number) => {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round(((pa >> sh) & 255) * (1 - p) + ((pb >> sh) & 255) * p);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
};

/** Text widths for every line the interpreter will draw, measured with the same fonts as the layout. */
function withWidths(o: VisualObject): VisualObject & Record<string, unknown> {
  const mono = !!o.mono || o.kind === "code" || o.kind === "source";
  const bold = !!o.bold || o.kind === "kicker";
  const extra: Record<string, unknown> = { widths: o.lines.map((l) => textWidth(l, o.fontSize, { mono, bold })) };
  if (o.sub?.length) {
    const subSize = o.kind === "kicker" ? 15 : o.kind === "list" ? 24 : o.kind === "code" ? 15 : o.kind === "node" ? 15 : 16;
    extra.subWidths = o.sub.map((l) => textWidth(l, subSize, { mono: o.kind === "kicker" || o.kind === "code", bold: o.kind === "list" || o.kind === "node" }));
  }
  if (o.kind === "code") extra.numWidths = o.lines.map((_, i) => textWidth(String((o.firstLine ?? 1) + i), o.fontSize - 2, { mono: true }));
  return { ...o, ...extra };
}

export function renderModel(scene: SceneSpec, style: keyof typeof PALETTES) {
  const P = PALETTES[style] ?? PALETTES.brody;
  const parents = new Set(scene.objects.filter((o) => o.kind === "cell" && o.parent).map((o) => o.parent!));
  return {
    version: MANIM_SCRIPT_VERSION,
    fonts: fontFiles(),
    // Pango registers DejaVuSansCondensed.ttf under the family "DejaVu Sans" (with a condensed stretch).
    fontSans: "DejaVu Sans",
    fontMono: "DejaVu Sans Mono",
    glyphs: GLYPHS,
    palette: { ...P, cellBusy: mix(P.panelRaised, P.accent, 0.18), cellOk: mix(P.panelRaised, P.ok, 0.16), cellBlocked: mix(P.panelRaised, P.signal, 0.16), track: mix(P.panelRaised, P.signal, 0.38) },
    scene: {
      ...scene,
      objects: scene.objects.map((o) => ({ ...withWidths(o), hasCells: parents.has(o.id) })),
      actions: scene.actions.map((a) => (a.kind === "label" ? { ...a, textWidth: textWidth(a.text ?? "", 16) } : a)),
    },
  };
}

export class ManimRenderer implements ExplainerRenderer {
  readonly id = "manim" as const;
  readonly label = "Manim";

  async unavailableReason(): Promise<string | null> {
    if (probe && Date.now() - probe.at < 5 * 60_000) return probe.reason;
    const py = explainerConfig().manimPython;
    try {
      const r = await run(py, ["-c", "import manim, manimpango, sys; print(manim.__version__)"], { timeoutMs: 60_000 });
      probe = r.code === 0 ? { at: Date.now(), reason: null, version: r.stdout.toString().trim() } : { at: Date.now(), reason: `Manim is not installed for ${py}. Run scripts/setup-explainer.sh, or set MANIM_PYTHON to a Python with manim.` };
    } catch {
      probe = { at: Date.now(), reason: `Python was not found (${py}). Set MANIM_PYTHON.` };
    }
    return probe.reason;
  }

  version(): string | undefined { return probe?.version; }

  async renderScene(scene: SceneSpec, ctx: RenderContext): Promise<SceneRender> {
    const t0 = Date.now();
    const cfg = explainerConfig();
    fs.mkdirSync(ctx.workDir, { recursive: true });
    const script = path.join(ctx.workDir, "brody_scene.py");
    const model = path.join(ctx.workDir, "scene-model.json");
    const report = path.join(ctx.workDir, "manim-report.json");
    fs.writeFileSync(script, MANIM_SCRIPT);
    fs.writeFileSync(model, JSON.stringify(renderModel(scene, ctx.style)));
    const media = path.join(ctx.workDir, "media");
    fs.rmSync(media, { recursive: true, force: true });
    const args = ["-m", "manim", "render", script, "BrodyScene", "--disable_caching", "--format", "mp4", "-r", `${ctx.width},${ctx.height}`, "--fps", String(ctx.fps), "--media_dir", media, "-o", "scene", "--progress_bar", "none", "-v", "WARNING"];
    const r = await run(cfg.manimPython, args, { cwd: ctx.workDir, timeoutMs: cfg.renderTimeoutMs, signal: ctx.signal, env: safeEnv({ BRODY_SCENE_MODEL: model, BRODY_SCENE_REPORT: report, MPLBACKEND: "Agg" }) });
    if (r.code !== 0) throw new Error(`Manim failed on ${scene.id} (exit ${r.code}): ${lastLines(r.stderr, 6)}`);
    const out = findMp4(media);
    if (!out) throw new Error(`Manim reported success for ${scene.id} but wrote no video.`);
    const video = path.join(ctx.workDir, "manim.mp4");
    fs.renameSync(out, video);
    let log = "";
    try { const rep = JSON.parse(fs.readFileSync(report, "utf8")) as { elapsed: number; overruns: { key: string; late: number }[] }; if (rep.overruns.length) log = `Manim overruns: ${rep.overruns.map((o) => `${o.key} +${o.late}s`).join(", ")}`; } catch { /* report is diagnostic only */ }
    return { video, sources: [script, model], renderer: "manim", ms: Date.now() - t0, cpuMs: 0, log };
  }
}

function findMp4(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findMp4(p); if (f) return f; }
    else if (e.name.endsWith(".mp4") && !p.includes("partial_movie_files")) return p;
  }
  return null;
}
