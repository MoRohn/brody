import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, DARK_SYNTAX, LIGHT_SYNTAX, parseColor } from "@/lib/syntax";
import { THEME_LEVELS, themeInitScript, isDarkLevel, levelAt, levelIndex } from "@/lib/theme";

/** Parses src/app/globals.css and resolves every colour token for each brightness level, the way the cascade does. */
const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function resolve(level: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const m of css.matchAll(/(:root[^{]*)\{([^}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    const applies = selectors.some((s) => s === ":root" || new RegExp(`data-level="${level}"`).test(s));
    if (!applies) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
  }
  return vars;
}

type RGB = [number, number, number];
function rgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}
function lum([r, g, b]: RGB): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Composite an rgba() tint over an opaque backdrop. */
function over(tint: string, backdrop: RGB): RGB {
  const m = tint.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)!;
  const a = Number(m[4]);
  return [1, 2, 3].map((i) => Math.round(Number(m[i]) * a + backdrop[i - 1] * (1 - a))) as RGB;
}

const LEVELS = THEME_LEVELS.map((l) => l.id);
const TEXT = ["--fg", "--fg2", "--muted", "--link", "--deep", "--crit", "--high", "--med", "--low", "--info", "--ok"];
const SURFACES = ["--bg", "--panel", "--panel2", "--code"];

describe("theme palette", () => {
  for (const level of LEVELS) {
    describe(`${level} level`, () => {
      const v = resolve(level);
      const c = (name: string): RGB => rgb(v[name]);

      it("defines every colour token as a solid hex", () => {
        for (const t of [...TEXT, ...SURFACES, "--line", "--line-strong", "--fill", "--fill-alt", "--on-fill", "--accent", "--accent-strong", "--accent-fg"]) expect(v[t], t).toMatch(/^#[0-9a-f]{6}$/i);
        expect(v["--accent-soft"]).toMatch(/^rgba\(/);
      });

      it("keeps every text role at WCAG AA (4.5:1) on every surface", () => {
        const failures: string[] = [];
        for (const t of TEXT) for (const s of SURFACES) { const r = ratio(c(t), c(s)); if (r < 4.5) failures.push(`${t} on ${s}: ${r.toFixed(2)}`); }
        expect(failures).toEqual([]);
      });

      it("keeps text readable on solid fills and on the soft accent tint", () => {
        expect(ratio(c("--on-fill"), c("--fill"))).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c("--on-fill"), c("--fill-alt"))).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c("--accent-fg"), c("--accent"))).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c("--accent-fg"), c("--accent-strong"))).toBeGreaterThanOrEqual(4.5);
        for (const s of ["--bg", "--panel"]) {
          const tint = over(v["--accent-soft"], c(s));
          for (const t of ["--fg", "--muted", "--link"]) expect(ratio(c(t), tint), `${t} on accent tint over ${s}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("keeps severity and status badges readable: their tint sits on an opaque panel base, wherever the badge is placed", () => {
        const failures: string[] = [];
        for (const t of ["--crit", "--high", "--med", "--low", "--info", "--ok", "--link", "--muted"]) {
          for (const a of [0.1, 0.11]) {
            const chip = [0, 1, 2].map((i) => Math.round(c(t)[i] * a + c("--panel")[i] * (1 - a))) as RGB;
            const r = ratio(c(t), chip);
            if (r < 4.5) failures.push(`${t} badge (${a * 100}% tint): ${r.toFixed(2)}`);
          }
        }
        expect(failures).toEqual([]);
      });

      it("makes controls and fills distinguishable from the surface (3:1)", () => {
        expect(ratio(c("--line-strong"), c("--panel"))).toBeGreaterThanOrEqual(3);
        expect(ratio(c("--fill"), c("--bg"))).toBeGreaterThanOrEqual(3);
        expect(ratio(c("--accent"), c("--panel"))).toBeGreaterThanOrEqual(3);
      });
    });
  }

  it("is built on the requested blues: the default fill is #1B4965 and the accent is #006C96", () => {
    expect(resolve("default")["--fill"].toLowerCase()).toBe("#1b4965");
    expect(resolve("default")["--accent"].toLowerCase()).toBe("#006c96");
  });

  it("orders the levels from brightest to darkest, so the slider is monotonic", () => {
    const l = LEVELS.map((id) => lum(rgb(resolve(id)["--bg"])));
    for (let i = 1; i < l.length; i++) expect(l[i]).toBeLessThan(l[i - 1]);
    expect(LEVELS.filter(isDarkLevel)).toEqual(["dark", "darkest"]);
    expect(levelAt(levelIndex("default")).id).toBe("default");
    expect(levelAt(99).id).toBe("darkest");
  });

  it("has swatches that match each level's real background", () => {
    const root = resolve("default");
    for (const id of LEVELS) expect(root[`--swatch-${id}`].toLowerCase(), id).toBe(resolve(id)["--bg"].toLowerCase());
  });

  it("applies a saved level before first paint, falls back to the OS preference, and never throws", () => {
    const run = (stored: string | null, dark: boolean) => {
      const attrs: Record<string, string> = {};
      const win = { matchMedia: () => ({ matches: dark }) };
      const doc = { documentElement: { setAttribute: (k: string, val: string) => { attrs[k] = val; } } };
      new Function("localStorage", "window", "document", themeInitScript)({ getItem: () => stored }, win, doc);
      return attrs["data-level"];
    };
    expect(run("darkest", false)).toBe("darkest");
    expect(run("nonsense", true)).toBe("dark");
    expect(run(null, false)).toBeUndefined();
    expect(() => new Function("localStorage", "window", "document", themeInitScript)({ getItem: () => { throw new Error("blocked"); } }, {}, { documentElement: { setAttribute() {} } })).not.toThrow();
  });

  it("keeps every syntax colour at AA on every code surface of its level", () => {
    const failures: string[] = [];
    for (const level of LEVELS) {
      const v = resolve(level);
      const theme = isDarkLevel(level) ? DARK_SYNTAX : LIGHT_SYNTAX;
      const colors = [theme.plain.color, ...theme.styles.map((st) => st.style.color)].filter((x): x is string => typeof x === "string");
      for (const s of ["--panel", "--panel2", "--code"]) {
        const bg = rgb(v[s]);
        const hover = over(v["--accent-soft"], bg);
        for (const col of colors) {
          const parsed = parseColor(col);
          if (!parsed) { failures.push(`${level}: unparseable colour ${col}`); continue; }
          for (const surface of [bg, hover]) { const r = contrast(parsed, surface); if (r < 4.5) failures.push(`${level} ${col} on ${s}: ${r.toFixed(2)}`); }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
