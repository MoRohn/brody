/**
 * Brightness levels, from brightest to darkest. The palette for each lives in src/app/globals.css under
 * `:root[data-level="<id>"]`; this module is the model around it: which levels exist, which is the default, how the
 * choice is stored, and the tiny script that applies it before first paint. Pure, so the server layout can import it.
 */
export const THEME_LEVELS = [
  { id: "bright", label: "Bright", description: "One step brighter than the original." },
  { id: "original", label: "Original", description: "Brody's first blue palette." },
  { id: "default", label: "Default", description: "Slightly deeper than the original. What you see first." },
  { id: "dark", label: "Dark", description: "Dark surfaces with light text." },
  { id: "darkest", label: "Darkest", description: "The deepest level, easiest on the eyes at night." },
] as const;

export type ThemeLevelId = (typeof THEME_LEVELS)[number]["id"];

export const DEFAULT_LEVEL: ThemeLevelId = "default";
export const STORAGE_KEY = "brody.theme";

export const isLevel = (value: unknown): value is ThemeLevelId => THEME_LEVELS.some((l) => l.id === value);
export const levelIndex = (id: ThemeLevelId) => THEME_LEVELS.findIndex((l) => l.id === id);
export const levelAt = (index: number) => THEME_LEVELS[Math.min(THEME_LEVELS.length - 1, Math.max(0, Math.round(index)))];
export const isDarkLevel = (id: ThemeLevelId) => levelIndex(id) >= levelIndex("dark");

/** The saved level, or null when nothing valid is saved or storage is unavailable (private mode, blocked, SSR). */
export function readStoredLevel(): ThemeLevelId | null {
  try {
    const saved = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    return isLevel(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function writeStoredLevel(level: ThemeLevelId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Storage unavailable: the choice still applies for this visit, it just is not remembered.
  }
}

/**
 * Runs before first paint (inlined in <head> by layout.tsx) so a saved level never flashes the default first. With
 * nothing saved, a reader whose system prefers dark starts on the Dark level. It must not throw: a page that cannot
 * read storage simply keeps the default palette.
 */
export const themeInitScript = `(function(){try{var ids=${JSON.stringify(THEME_LEVELS.map((x) => x.id))};var l=null;try{l=localStorage.getItem(${JSON.stringify(STORAGE_KEY)})}catch(e){}if(ids.indexOf(l)<0){l=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":null}if(l)document.documentElement.setAttribute("data-level",l)}catch(e){}})()`;
