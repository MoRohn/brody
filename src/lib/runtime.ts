import fs from "node:fs";

/** Whether Brody is running inside a container, which changes where keys are entered and how a restart is done. */
export function runtimeKind(): "docker" | "local" {
  try {
    return fs.existsSync("/.dockerenv") ? "docker" : "local";
  } catch {
    return "local";
  }
}

export const RESTART_COMMAND = { docker: "docker compose up -d", local: "brody restart" } as const;
