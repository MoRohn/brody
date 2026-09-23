import fs from "node:fs";

/** Whether Brody is running inside a container, which changes where keys are entered and how a restart is done. */
let kind: "docker" | "local" | undefined;
export function runtimeKind(): "docker" | "local" {
  if (kind) return kind;
  try {
    kind = fs.existsSync("/.dockerenv") ? "docker" : "local"; // brody-ignore: sync-io (once per process)
  } catch {
    kind = "local";
  }
  return kind;
}

export const RESTART_COMMAND = { docker: "docker compose up -d", local: "brody restart" } as const;
