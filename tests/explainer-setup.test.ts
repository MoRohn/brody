/**
 * Automatic explainer tool setup: when it runs, when it must not, what it remembers, and the setup endpoint. The real
 * setup (tools/setup-explainer.mjs, the same on every OS) runs in check mode here; the full Manim install is exercised with EXPLAINER_SETUP_INSTALL_TEST=1 (it downloads
 * Manim into a temporary virtualenv).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoSetupDecision, runExplainerSetup, setupScript, setupState, toolSummary } from "@/lib/explainer/setup";
import { explainerVenv } from "@/lib/explainer/config";
import { POST } from "@/app/api/explainer/setup/route";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-explainer-setup-"));
const memory = path.join(dir, "explainer-setup.json");
const clean = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra }) as unknown as NodeJS.ProcessEnv;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

beforeEach(() => { process.env.EXPLAINER_SETUP_STATE_PATH = memory; fs.rmSync(memory, { force: true }); (globalThis as { __brodyExplainerSetup?: unknown }).__brodyExplainerSetup = undefined; });
afterEach(() => { delete process.env.EXPLAINER_SETUP_STATE_PATH; delete process.env.BRODY_EXPLAINER_VENV; });

describe("when automatic setup runs", () => {
  it("runs on a developer machine where nothing says otherwise", () => {
    expect(setupScript()).toMatch(/tools[\\/]setup-explainer\.mjs$/);
    expect(autoSetupDecision(clean())).toEqual({ run: true, reason: "check, and install Manim if it is missing" });
  });
  it("never runs when turned off, in CI or tests, or when Manim is managed elsewhere", () => {
    expect(autoSetupDecision(clean({ EXPLAINER_AUTO_SETUP: "off" })).reason).toMatch(/EXPLAINER_AUTO_SETUP=off/);
    expect(autoSetupDecision(clean({ CI: "true" })).run).toBe(false);
    expect(autoSetupDecision(clean({ VITEST: "true" })).run).toBe(false);
    expect(autoSetupDecision(process.env).run).toBe(false); // this test run itself
    expect(autoSetupDecision(clean({ MANIM_PYTHON: "/opt/py/bin/python" })).reason).toMatch(/managed outside Brody/);
  });
  it("backs off for a day after an attempt that could not finish, for the same virtualenv", () => {
    const now = Date.now();
    fs.writeFileSync(memory, JSON.stringify({ at: now - 60_000, outcome: "needs-system-libraries", venv: explainerVenv() }));
    expect(autoSetupDecision(clean(), now).reason).toMatch(/needs-system-libraries.*retried after a day/);
    expect(autoSetupDecision(clean(), now + 25 * 3600_000).run).toBe(true);
    fs.writeFileSync(memory, JSON.stringify({ at: now - 60_000, outcome: "ready", venv: explainerVenv() }));
    expect(autoSetupDecision(clean(), now).run).toBe(true); // a good state is always re-checked: cheap, and catches a removed venv
    fs.writeFileSync(memory, JSON.stringify({ at: now - 60_000, outcome: "failed", venv: "/somewhere/else" }));
    expect(autoSetupDecision(clean(), now).run).toBe(true); // a different virtualenv is a fresh start
  });
});

describe("the setup run", () => {
  it("checks with the real script, reports the outcome, and remembers it", async (ctx) => {
    if (!hasFfmpeg) ctx.skip();
    const s = await runExplainerSetup("manual");
    expect(["ready", "installed", "needs-system-libraries", "failed"]).toContain(s.outcome);
    expect(s.log.join("\n")).toMatch(/FFmpeg/);
    expect(JSON.parse(fs.readFileSync(memory, "utf8"))).toMatchObject({ outcome: s.outcome === "installed" ? "installed" : s.outcome, venv: explainerVenv() });
    const summary = await toolSummary();
    expect(summary.ffmpeg).toMatch(/^\d/);
    expect(summary.setup.outcome).toBe(s.outcome);
  }, 120_000);

  it("reports a missing virtualenv as installable in check mode, without installing anything", () => {
    const venv = path.join(dir, "no-venv");
    const r = spawnSync(process.execPath, [setupScript()!, "--check"], { env: { ...process.env, BRODY_EXPLAINER_VENV: venv }, encoding: "utf8" });
    if (!hasFfmpeg) { expect(r.status).toBe(1); return; }
    expect([2, 3]).toContain(r.status); // 3: installable; 2: cairo/pango missing on this machine
    expect(fs.existsSync(venv)).toBe(false);
  });

  it("runs once at a time", async (ctx) => {
    if (!hasFfmpeg) ctx.skip();
    const a = runExplainerSetup("manual");
    const b = await runExplainerSetup("startup");
    expect(b.state).toBe("checking");
    expect(b.trigger).toBe("manual");
    await a;
    expect(["done", "skipped", "failed"]).toContain(setupState().state);
  }, 120_000);

  it.runIf(process.env.EXPLAINER_SETUP_INSTALL_TEST === "1")("installs Manim into an empty virtualenv when it is missing", async () => {
    process.env.BRODY_EXPLAINER_VENV = path.join(dir, "venv");
    const s = await runExplainerSetup("manual");
    expect(s.outcome).toBe("installed");
    expect(spawnSync(path.join(dir, "venv", "bin", "python"), ["-c", "import manim"]).status).toBe(0);
  }, 900_000);

  it("only starts from a JSON request", async () => {
    expect((await POST(new Request("http://x/api/explainer/setup", { method: "POST", body: "x", headers: { "content-type": "text/plain" } }))).status).toBe(415);
  });
});

describe("the FFmpeg check", () => {
  it("names a missing FFmpeg, and an FFmpeg without the H.264 or AAC encoder, before a video starts", async () => {
    const { ffmpegProblem } = await import("@/lib/explainer/media");
    const saved = process.env.FFMPEG_PATH;
    try {
      process.env.FFMPEG_PATH = path.join(os.tmpdir(), "no-such-ffmpeg-brody");
      expect(await ffmpegProblem()).toMatch(/not installed/);
      if (process.platform !== "win32") {
        // A stand-in FFmpeg that lists only an MPEG-4 encoder.
        const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brody-ff-")), "ffmpeg");
        fs.writeFileSync(fake, "#!/bin/sh\necho ' V..... mpeg4  MPEG-4 part 2'\n", { mode: 0o755 });
        process.env.FFMPEG_PATH = fake;
        expect(await ffmpegProblem()).toMatch(/no H\.264 \(libx264\) or AAC encoder/);
      }
    } finally {
      if (saved === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved;
    }
    const real = await ffmpegProblem();
    if (spawnSync("ffmpeg", ["-version"]).status === 0) expect((await toolSummary()).ffmpegProblem).toBe(real);
  });
});
