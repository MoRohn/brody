import { Resvg } from "@resvg/resvg-js";
import type { DeckImage } from "./scene";

/** The largest box with the image's proportions that fits in the given one, aligned within it. */
export function containRect(iw: number, ih: number, x: number, y: number, w: number, h: number, align: "l" | "c" | "r" = "c", valign: "t" | "m" | "b" = "m"): { x: number; y: number; w: number; h: number } {
  const s = Math.min(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  return { x: align === "l" ? x : align === "c" ? x + (w - dw) / 2 : x + w - dw, y: valign === "t" ? y : valign === "m" ? y + (h - dh) / 2 : y + h - dh, w: dw, h: dh };
}

/**
 * The image cut to an aspect ratio, as PNG: a tall image keeps its top (where a screenshot carries its header and
 * headline), a wide one its centre. The renderers draw images whole, so cropping happens here, once, for every format.
 */
export function cropImage(img: DeckImage, aspect: number): DeckImage {
  const current = img.width / img.height;
  if (Math.abs(current - aspect) < 0.01) return img;
  const cw = current > aspect ? Math.round(img.height * aspect) : img.width;
  const ch = current > aspect ? img.height : Math.round(img.width / aspect);
  const ox = Math.round((img.width - cw) / 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="${ox} 0 ${cw} ${ch}"><image href="data:${img.mime};base64,${img.data.toString("base64")}" width="${img.width}" height="${img.height}" preserveAspectRatio="none"/></svg>`;
  const out = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  return { mime: "image/png", width: out.width, height: out.height, data: out.asPng() };
}
