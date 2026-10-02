import type { RendererId, SceneSpec, VisualStyle } from "../types";

export interface RenderContext {
  /** Directory for this scene's renderer sources and raw output. */
  workDir: string;
  style: VisualStyle;
  fps: number;
  width: number;
  height: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface SceneRender {
  /** H.264 video with exactly scene.frameCount frames (after conforming). */
  video: string;
  /** Files that produced it (the Manim script, the scene JSON), kept for reproducibility. */
  sources: string[];
  renderer: RendererId;
  ms: number;
  /** In-process CPU time spent, when the renderer runs in this process. */
  cpuMs: number;
  log?: string;
}

/**
 * A renderer draws one scene. It must honour the scene's frame count exactly; the pipeline still conforms the output,
 * and validation checks it, but a renderer that drifts is a bug.
 */
export interface ExplainerRenderer {
  readonly id: RendererId;
  readonly label: string;
  /** Null when usable; otherwise why not. */
  unavailableReason(): Promise<string | null>;
  renderScene(scene: SceneSpec, ctx: RenderContext): Promise<SceneRender>;
}
