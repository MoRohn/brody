import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

/**
 * Zip a directory's contents (paths relative to it, forward slashes, .DS_Store skipped) into `zipPath`, like
 * `zip -qr zipPath . -x "*.DS_Store"` but in-process, so the browser suite runs on Windows, which has no zip command.
 */
export function zipDirectory(dir: string, zipPath: string): void {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name !== ".DS_Store") files[path.relative(dir, abs).split(path.sep).join("/")] = fs.readFileSync(abs);
    }
  };
  walk(dir);
  fs.writeFileSync(zipPath, zipSync(files, { level: 6 }));
}
