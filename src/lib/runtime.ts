import fs from "node:fs";

/** Whether Brody is running inside a container, which changes where keys are entered and how a restart is done. */
let kind: "docker" | "local" | undefined;
export function runtimeKind(): "docker" | "local" {
  // BRODY_RUNTIME pins the answer: tests run inside containers too, and must not change behaviour because of it.
  const pinned = process.env.BRODY_RUNTIME;
  if (pinned === "docker" || pinned === "local") return pinned;
  if (kind) return kind;
  try {
    // Docker marks containers with /.dockerenv, Podman with /run/.containerenv.
    kind = fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv") ? "docker" : "local"; // brody-ignore: sync-io (once per process)
  } catch {
    kind = "local";
  }
  return kind;
}

/** The brody launcher is a shell script (macOS and Linux); on Windows Brody is restarted with npm. */
export const RESTART_COMMAND = { docker: "docker compose up -d", local: process.platform === "win32" ? "npm start" : "brody restart" } as const;
