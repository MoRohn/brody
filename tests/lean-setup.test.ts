import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { findLean, resetLean } from "@/lib/formal";
import { GET, POST } from "@/app/api/formal/lean/route";

// A fake elan home whose toolchains hold stand-in `lean` binaries that only answer --version.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "brody-elan-test-"));
const saved = { ELAN_HOME: process.env.ELAN_HOME, PATH: process.env.PATH, leanBin: config.formal.leanBin };

function toolchain(dir: string, version: string) {
  const bin = path.join(home, "toolchains", dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "lean"), `#!/bin/sh\necho "Lean (version ${version}, test)"\n`, { mode: 0o755 });
}

beforeAll(() => {
  process.env.ELAN_HOME = home;
  process.env.PATH = "/usr/bin:/bin"; // no real `lean` or elan proxy on PATH
  config.formal.leanBin = undefined;
});
afterAll(() => {
  process.env.ELAN_HOME = saved.ELAN_HOME;
  process.env.PATH = saved.PATH;
  config.formal.leanBin = saved.leanBin;
  resetLean();
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => resetLean());

describe.skipIf(process.platform === "win32")("Lean discovery without an elan default toolchain", () => {
  it("reports Lean as missing when no toolchain is installed, pointing at Add Lean", async () => {
    expect(await findLean()).toBeNull();
    const { leanUnavailableReason } = await import("@/lib/formal");
    expect(leanUnavailableReason()).toMatch(/Add Lean/);
  });

  it("uses the newest installed toolchain that is recent enough", async () => {
    toolchain("leanprover--lean4---v4.10.0", "4.10.0");
    toolchain("leanprover--lean4---v4.34.0", "4.34.0");
    toolchain("leanprover--lean4---v4.20.1", "4.20.1");
    const lean = await findLean();
    expect(lean?.version).toBe("4.34.0");
    expect(lean?.bin).toBe(path.join(home, "toolchains", "leanprover--lean4---v4.34.0", "bin", "lean"));
  });

  it("prefers elan's default toolchain and skips half-downloaded ones", async () => {
    fs.writeFileSync(path.join(home, "settings.toml"), 'default_toolchain = "leanprover/lean4:v4.20.1"\n');
    toolchain("leanprover--lean4---v4.40.0.tmp", "4.40.0");
    try {
      expect((await findLean())?.version).toBe("4.20.1");
      fs.rmSync(path.join(home, "settings.toml"));
      resetLean();
      expect((await findLean())?.version).toBe("4.34.0"); // .tmp is still downloading, never used
    } finally {
      fs.rmSync(path.join(home, "toolchains", "leanprover--lean4---v4.40.0.tmp"), { recursive: true, force: true });
      fs.rmSync(path.join(home, "settings.toml"), { force: true });
    }
  });

  it("never runs elan's lean proxy, which would download a missing toolchain and hang", async () => {
    // The proxy is elan itself under the name `lean`; this stand-in would hang the check if it were ever run.
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "elan"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    fs.symlinkSync(path.join(bin, "elan"), path.join(bin, "lean"));
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    try {
      const started = Date.now();
      expect((await findLean())?.version).toBe("4.34.0");
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      process.env.PATH = "/usr/bin:/bin";
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 10_000);

  it("finds Lean installed after a miss once the re-check interval has passed", async () => {
    fs.rmSync(path.join(home, "toolchains"), { recursive: true, force: true });
    expect(await findLean()).toBeNull();
    toolchain("leanprover--lean4---v4.34.0", "4.34.0");
    expect(await findLean()).toBeNull(); // still cached
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect((await findLean())?.version).toBe("4.34.0");
    } finally {
      Date.now = realNow;
    }
  });
});

describe("Add Lean endpoint", () => {
  const post = (headers: Record<string, string>) => POST(new Request("http://localhost:3003/api/formal/lean", { method: "POST", headers, body: "{}" }));

  it("reports an idle install", async () => {
    expect(await (await GET()).json()).toEqual({ install: { state: "idle" } });
  });

  it("refuses cross-site requests and non-JSON posts, so another page cannot start an install", async () => {
    expect((await post({ "content-type": "application/json", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ "content-type": "text/plain", "sec-fetch-site": "same-origin" })).status).toBe(403);
    expect((await post({ "content-type": "application/x-www-form-urlencoded" })).status).toBe(403);
  });

  it("explains why it cannot install when LEAN_BIN is set", async () => {
    config.formal.leanBin = "/nowhere/lean";
    try {
      const res = await post({ "content-type": "application/json", "sec-fetch-site": "same-origin" });
      expect(res.status).toBe(400);
      expect((await res.json()).error.hint).toMatch(/LEAN_BIN/);
    } finally {
      config.formal.leanBin = undefined;
    }
  });
});
