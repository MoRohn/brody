import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import { getDb, schema } from "@/lib/db/client";
import { fetchGitHubMetadata, parseGitHubUrl, downloadGitHubSnapshot } from "@/lib/ingest/github";
import { readDirectory } from "@/lib/ingest/fs";
import { normalizeFiles } from "@/lib/ingest/normalize";
import { sanitizeRelativePath } from "@/lib/ingest/paths";
import { ingestUpload } from "@/lib/ingest/upload";
import { extractZip } from "@/lib/ingest/zip";
import { AppError } from "@/lib/util/errors";
import { fixtureFiles, freshDb } from "./helpers";
import { makeZip } from "./helpers/zip";

beforeEach(() => freshDb());

const expectAppError = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
};

describe("ingestion: sources", () => {
  it("ingests a single file", async () => {
    const r = await ingestUpload("file", [{ name: "hello.py", content: Buffer.from("def hello():\n    return 1\n") }]);
    const files = getDb().select().from(schema.files).all();
    expect(files.map((f) => f.path)).toEqual(["hello.py"]);
    expect(files[0].language).toBe("Python");
    expect(r.stats.included).toBe(1);
  });

  it("ingests multiple files and de-duplicates colliding names", async () => {
    await ingestUpload("files", [{ name: "a.ts", content: Buffer.from("export const a = 1;\n") }, { name: "dir/a.ts", content: Buffer.from("export const b = 2;\n") }]);
    const paths = getDb().select().from(schema.files).all().map((f) => f.path).sort();
    expect(paths).toEqual(["a-2.ts", "a.ts"]);
  });

  it("ingests a folder, strips the shared root and keeps structure", async () => {
    await ingestUpload("folder", [
      { name: "proj/src/index.ts", content: Buffer.from("export {};\n") },
      { name: "proj/README.md", content: Buffer.from("# Proj\n") },
    ]);
    const paths = getDb().select().from(schema.files).all().map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "src/index.ts"]);
    expect(getDb().select().from(schema.projects).get()!.name).toBe("proj");
  });

  it("ingests a ZIP archive (GitHub-style wrapper directory is removed)", async () => {
    const zip = makeZip([{ name: "owner-repo-abc123/" }, { name: "owner-repo-abc123/main.go", data: "package main\nfunc main() {}\n" }, { name: "owner-repo-abc123/go.mod", data: "module x\n" }]);
    await ingestUpload("zip", [{ name: "repo.zip", content: zip }]);
    expect(getDb().select().from(schema.files).all().map((f) => f.path).sort()).toEqual(["go.mod", "main.go"]);
  });

  it("ingests the whole fixture folder", async () => {
    const { files, stats } = normalizeFiles(fixtureFiles());
    expect(stats.included).toBe(files.length);
    expect(stats.languages.TypeScript).toBeGreaterThan(0);
  });
});

describe("ingestion: exclusions, binaries and classification", () => {
  const raw = (p: string, c: string | Buffer) => ({ path: p, content: Buffer.isBuffer(c) ? c : Buffer.from(c) });

  it("excludes default noise but keeps it inspectable", () => {
    const { files, stats } = normalizeFiles([raw("src/a.ts", "export {};\n"), raw("node_modules/x/index.js", "module.exports = 1;\n"), raw("dist/bundle.js", "var a=1;\n"), raw(".git/config", "[core]\n")]);
    const nm = files.find((f) => f.path.startsWith("node_modules"))!;
    expect(nm.isExcluded).toBe(true);
    expect(nm.excludeReason).toContain("node_modules");
    expect(nm.text).toBeDefined(); // still readable
    expect(stats.excluded).toBe(3);
    expect(stats.included).toBe(1);
  });

  it("honours .gitignore, including nested rules", () => {
    const { files } = normalizeFiles([raw(".gitignore", "*.log\nsecret/\n"), raw("a.log", "x"), raw("secret/k.ts", "export {};"), raw("pkg/.gitignore", "gen.ts\n"), raw("pkg/gen.ts", "export {};"), raw("pkg/keep.ts", "export {};")]);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by["a.log"].isExcluded).toBe(true);
    expect(by["secret/k.ts"].isExcluded).toBe(true);
    expect(by["pkg/gen.ts"].isExcluded).toBe(true);
    expect(by["pkg/keep.ts"].isExcluded).toBe(false);
  });

  it("detects binary files and never treats them as text", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0, 1, 2, 3, 0, 0, 0, 0]);
    const { files } = normalizeFiles([raw("logo.png", png), raw("src/a.ts", "export {};")]);
    const b = files.find((f) => f.path === "logo.png")!;
    expect(b.isBinary).toBe(true);
    expect(b.text).toBeUndefined();
    expect(b.hasContent).toBe(false);
  });

  it("classifies tests, configs, manifests, CI, infra, docs and schemas", () => {
    const { files } = normalizeFiles([
      raw("src/a.test.ts", "it('x', () => {});"), raw("tsconfig.json", "{}"), raw("package.json", "{}"), raw(".github/workflows/ci.yml", "name: ci\n"),
      raw("Dockerfile", "FROM node\n"), raw("docs/guide.md", "# Guide\n"), raw("db/schema.sql", "CREATE TABLE t (id int);"), raw("src/app.ts", "export {};"), raw("yarn.lock", "# lock\n"),
    ]);
    const c = Object.fromEntries(files.map((f) => [f.path, f.classification]));
    expect(c["src/a.test.ts"]).toBe("test");
    expect(c["package.json"]).toBe("manifest");
    expect(c[".github/workflows/ci.yml"]).toBe("ci");
    expect(c["Dockerfile"]).toBe("infra");
    expect(c["docs/guide.md"]).toBe("docs");
    expect(c["db/schema.sql"]).toBe("schema");
    expect(c["src/app.ts"]).toBe("source");
    expect(c["yarn.lock"]).toBe("lockfile");
  });

  it("hashes files, flags large files and detects duplicates", () => {
    const big = "x".repeat(config.limits.largeFileBytes + 10);
    const dup = "export const same = 'a duplicated file with enough bytes to matter for detection';\n";
    const { files } = normalizeFiles([raw("big.ts", big), raw("a.ts", dup), raw("b.ts", dup)]);
    expect(files.find((f) => f.path === "big.ts")!.isLarge).toBe(true);
    expect(files.find((f) => f.path === "a.ts")!.hash).toHaveLength(64);
    expect(files.find((f) => f.path === "b.ts")!.duplicateOf).toBe("a.ts");
  });

  it("keeps only metadata for files above the size limit and warns", () => {
    const original = config.limits.maxFileBytes;
    config.limits.maxFileBytes = 50;
    try {
      const { files, stats } = normalizeFiles([raw("huge.ts", "a".repeat(200))]);
      expect(files[0].text).toBeUndefined();
      expect(files[0].hasContent).toBe(false);
      expect(stats.warnings.join(" ")).toContain("huge.ts");
    } finally { config.limits.maxFileBytes = original; }
  });
});

describe("ingestion: failure states", () => {
  it("rejects an empty upload with guidance", async () => {
    const e = await expectAppError(ingestUpload("files", []), "empty_upload");
    expect(e.hint).toBeTruthy();
  });
  it("rejects a malformed archive", async () => {
    const e = await expectAppError(ingestUpload("zip", [{ name: "x.zip", content: Buffer.from("not a zip at all") }]), "bad_zip");
    expect(e.message).toContain("not a valid ZIP");
  });
  it("rejects an archive whose files are all excluded", async () => {
    await expectAppError(ingestUpload("zip", [{ name: "x.zip", content: makeZip([{ name: "node_modules/a/index.js", data: "1" }]) }]), "no_source");
  });
  it("rejects binary-only uploads", async () => {
    await expectAppError(ingestUpload("files", [{ name: "a.bin", content: Buffer.from([0, 1, 2, 3, 0, 0, 0, 9, 8, 0]) }]), "binary_only");
  });
  it("rejects uploads over the file-count limit", async () => {
    const original = config.limits.maxFiles;
    config.limits.maxFiles = 2;
    try { await expectAppError(ingestUpload("files", [1, 2, 3].map((i) => ({ name: `f${i}.ts`, content: Buffer.from("export {};") }))), "repo_too_large"); }
    finally { config.limits.maxFiles = original; }
  });
});

describe("security: untrusted archives and paths", () => {
  it("rejects path traversal entries (zip-slip)", async () => {
    await expectAppError(extractZip(makeZip([{ name: "../../etc/passwd", data: "root:x" }])), "path_traversal");
    await expectAppError(extractZip(makeZip([{ name: "a/../../evil.sh", data: "x" }])), "path_traversal");
  });
  it("rejects absolute paths, Windows drive paths and NUL bytes", async () => {
    await expectAppError(extractZip(makeZip([{ name: "/etc/passwd", data: "x" }])), "path_traversal");
    await expectAppError(extractZip(makeZip([{ name: "C:\\Windows\\x.dll", data: "x" }])), "path_traversal");
    expect(() => sanitizeRelativePath("a\0b")).toThrow(AppError);
  });
  it("normalises backslashes and dot segments in safe paths", () => {
    expect(sanitizeRelativePath("./a\\b/./c.ts")).toBe("a/b/c.ts");
    expect(sanitizeRelativePath("dir/")).toBeUndefined();
  });
  it("skips symlink entries instead of following them", async () => {
    const r = await extractZip(makeZip([{ name: "link", data: "/etc/passwd", mode: 0o120777 }, { name: "ok.ts", data: "export {};" }]));
    expect(r.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(r.skipped[0].reason).toContain("symbolic link");
  });
  it("rejects decompression bombs by compression ratio", async () => {
    const bomb = makeZip([{ name: "zeros.txt", data: Buffer.alloc(8 * 1024 * 1024, 0) }]);
    expect(bomb.length).toBeLessThan(50_000);
    await expectAppError(extractZip(bomb), "zip_bomb");
  });
  it("skips oversized entries and enforces the total size limit", async () => {
    const orig = { f: config.limits.maxFileBytes, t: config.limits.maxTotalBytes };
    config.limits.maxFileBytes = 1000;
    try {
      const r = await extractZip(makeZip([{ name: "big.txt", data: Buffer.alloc(20_000, 65) }, { name: "s.ts", data: "x" }]));
      expect(r.skipped.some((s) => s.path === "big.txt")).toBe(true);
      config.limits.maxTotalBytes = 100;
      await expectAppError(extractZip(makeZip([{ name: "a.ts", data: Buffer.alloc(500, 66) }])), "repo_too_large");
    } finally { config.limits.maxFileBytes = orig.f; config.limits.maxTotalBytes = orig.t; }
  });
  it("limits the number of archive entries", async () => {
    const o = config.limits.maxZipEntries;
    config.limits.maxZipEntries = 3;
    try { await expectAppError(extractZip(makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.ts`, data: "x" })))), "zip_too_many_entries"); }
    finally { config.limits.maxZipEntries = o; }
  });
  it("never follows symlinks when reading a local folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brody-fs-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "brody-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
    fs.writeFileSync(path.join(dir, "ok.ts"), "export {};");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "leak.txt"));
    fs.symlinkSync(outside, path.join(dir, "linkdir"));
    const { files, skippedLinks } = readDirectory(dir);
    expect(files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(skippedLinks.sort()).toEqual(["leak.txt", "linkdir"]);
    expect(files.some((f) => f.content.toString().includes("TOP SECRET"))).toBe(false);
  });
});

describe("GitHub import", () => {
  it("parses URL variants and rejects garbage", () => {
    expect(parseGitHubUrl("https://github.com/vercel/next.js")).toEqual({ owner: "vercel", repo: "next.js", ref: undefined });
    expect(parseGitHubUrl("github.com/a/b.git")).toMatchObject({ owner: "a", repo: "b" });
    expect(parseGitHubUrl("https://github.com/a/b/tree/feature/x-y")).toMatchObject({ ref: "feature/x-y" });
    expect(parseGitHubUrl("git@github.com:a/b.git")).toMatchObject({ owner: "a", repo: "b" });
    expect(parseGitHubUrl("owner/repo")).toMatchObject({ owner: "owner", repo: "repo" });
    expect(() => parseGitHubUrl("https://gitlab.com/a/b")).toThrow(AppError);
    expect(() => parseGitHubUrl("not a url")).toThrow(/recognizable/);
  });

  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  it("fetches metadata and downloads a snapshot, sending the token only as an Authorization header", async () => {
    const zip = makeZip([{ name: "o-r-abc/", }, { name: "o-r-abc/main.py", data: "print(1)\n" }]);
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push({ url, auth: h.get("authorization") });
      if (url.endsWith("/repos/o/r")) return json({ name: "r", full_name: "o/r", description: "d", default_branch: "main", size: 12, private: true, html_url: "https://github.com/o/r", owner: { login: "o" } });
      if (url.includes("/commits/main")) return json({ sha: "a".repeat(40), commit: { message: "first commit\n\nbody", committer: { date: "2026-01-01T00:00:00Z" } } });
      if (url.endsWith("/languages")) return json({ Python: 900, Shell: 100 });
      if (url.includes("/git/trees/")) return json({ tree: [{ type: "blob" }, { type: "blob" }, { type: "tree" }], truncated: false });
      if (url.includes("/zipball/")) return new Response(new Uint8Array(zip), { status: 200 });
      return json({}, 404);
    }));
    try {
      const meta = await fetchGitHubMetadata({ owner: "o", repo: "r" }, "ghp_" + "a".repeat(36));
      expect(meta).toMatchObject({ fullName: "o/r", branch: "main", commit: "a".repeat(40), isPrivate: true, approximateFileCount: 2, commitMessage: "first commit" });
      const snap = await downloadGitHubSnapshot({ owner: "o", repo: "r" }, meta.commit, "ghp_" + "a".repeat(36));
      expect(snap.files.map((f) => f.path)).toEqual(["main.py"]);
      expect(seen.every((s) => s.auth === `Bearer ghp_${"a".repeat(36)}`)).toBe(true);
      expect(seen.every((s) => !s.url.includes("ghp_"))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it("explains inaccessible private repositories, bad refs and rate limits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Not Found" }, 404)));
    try {
      const e = await expectAppError(fetchGitHubMetadata({ owner: "o", repo: "private" }), "github_not_found");
      expect(e.hint).toContain("token");
    } finally { vi.unstubAllGlobals(); }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })));
    try { await expectAppError(fetchGitHubMetadata({ owner: "o", repo: "r" }), "github_rate_limited"); } finally { vi.unstubAllGlobals(); }
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Bad credentials" }, 401)));
    try { await expectAppError(fetchGitHubMetadata({ owner: "o", repo: "r" }, "bad"), "github_unauthorized"); } finally { vi.unstubAllGlobals(); }
  });

  it("reports an unreachable GitHub without leaking tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED with token ghp_" + "b".repeat(36)); }));
    try {
      const e = await expectAppError(fetchGitHubMetadata({ owner: "o", repo: "r" }, "ghp_" + "b".repeat(36)), "github_unreachable");
      expect(e.message).not.toContain("ghp_" + "b".repeat(36));
    } finally { vi.unstubAllGlobals(); }
  });
});
