/**
 * Renderer registry. Renderers are chosen per scene by the scene planner (scenes.ts: Manim for systems, relationships and
 * transformations; HTML for statements, data cards, code and timelines), so one video can mix engines: every scene is
 * conformed to the same codec, size and frame rate before the scenes are joined. Future engines (Remotion, Three.js,
 * WebGL) implement ExplainerRenderer and register here.
 */
import { HtmlRenderer } from "./html";
import { ManimRenderer } from "./manim";
import type { RendererId } from "../types";
import type { ExplainerRenderer } from "./types";

export * from "./types";
export { HtmlRenderer } from "./html";
export { ManimRenderer } from "./manim";

interface Reg { list: ExplainerRenderer[]; override?: ExplainerRenderer[] }
const reg: Reg = ((globalThis as unknown as { __brodyRenderers?: Reg }).__brodyRenderers ??= { list: [new ManimRenderer(), new HtmlRenderer()] });

export function setRenderers(list: ExplainerRenderer[] | undefined): void { reg.override = list; }
export function allRenderers(): ExplainerRenderer[] { return reg.override ?? reg.list; }
export function getRenderer(id: RendererId): ExplainerRenderer | undefined { return allRenderers().find((r) => r.id === id); }

export async function availableRenderers(): Promise<{ id: RendererId; label: string; available: boolean; reason: string | null }[]> {
  return Promise.all(allRenderers().map(async (r) => { const reason = await r.unavailableReason(); return { id: r.id, label: r.label, available: reason === null, reason }; }));
}
