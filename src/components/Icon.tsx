import type { SVGProps } from "react";

/**
 * One consistent, stroke-based icon set (24px grid, 1.75 stroke, currentColor) so the interface reads as a single
 * system instead of a mix of text glyphs.
 */
const PATHS = {
  overview: ["M3 3h7v9H3z", "M14 3h7v5h-7z", "M14 12h7v9h-7z", "M3 16h7v5H3z"],
  review: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", "M9 12l2 2 4-4"],
  gauge: ["M12 14l4-4", "M3.34 19a10 10 0 1 1 17.32 0", "M12 14m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0"],
  proof: ["M4 3h16v13H4z", "M8 21l4-5 4 5", "M8.5 9.5l2.5 2.5 4.5-5"],
  explain: ["M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z", "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"],
  architecture: ["M12 2 2 7l10 5 10-5z", "M2 12l10 5 10-5", "M2 17l10 5 10-5"],
  map: ["M6 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0", "M18 5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0", "M12 19m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0", "M7.6 7.9l3 8.3", "M16.4 7.2 13 16.6", "M8.4 5.4l7.1-.3"],
  files: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M9 13l-2 2 2 2", "M15 13l2 2-2 2"],
  ask: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", "M9.5 8.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5", "M12 15h.01"],
  deck: ["M3 4h18v12H3z", "M8 20h8", "M12 16v4", "M7 12l3-3 3 2 4-4"],
  reports: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"],
  gear: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ],
  sun: ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M12 2v2", "M12 20v2", "M4.93 4.93l1.41 1.41", "M17.66 17.66l1.41 1.41", "M2 12h2", "M20 12h2", "M6.34 17.66l-1.41 1.41", "M19.07 4.93l-1.41 1.41"],
  moon: ["M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
  upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M17 8l-5-5-5 5", "M12 3v12"],
  chevron: ["M6 9l6 6 6-6"],
  check: ["M20 6L9 17l-5-5"],
  x: ["M18 6L6 18", "M6 6l12 12"],
  refresh: ["M21 12a9 9 0 1 1-3-6.7", "M21 3v6h-6"],
  github: ["M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className ?? ""}`} {...rest}>
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
