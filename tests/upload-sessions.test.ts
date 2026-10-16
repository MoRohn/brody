import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as createSession } from "@/app/api/projects/upload/sessions/route";
import { DELETE as cancelSession, PUT as putPieces } from "@/app/api/projects/upload/sessions/[id]/route";
import { POST as finishSession } from "@/app/api/projects/upload/sessions/[id]/finish/route";
import { config } from "@/lib/config";
import { getDb, schema } from "@/lib/db/client";
import { normalizeFiles, normalizeStagedFiles } from "@/lib/ingest/normalize";
import { UPLOAD_PIECE_BYTES } from "@/lib/ingest/sessions";
import { stagingRoot, sweepStaging } from "@/lib/ingest/staging";
import { sha256 } from "@/lib/util/ids";
import { fixtureFiles, freshDb } from "./helpers";
import { makeZip } from "./helpers/zip";

beforeEach(() => freshDb());

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (body: unknown) => new Request("http://localhost/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const read = async (res: Response) => ({ status: res.status, json: await res.json() });

async function start(mode: string, files: { path: string; data: Buffer }[], extra: Record<string, string> = {}) {
  const r = await read(await createSession(jsonReq({ mode, ...extra, files: files.map((f) => ({ path: f.path, size: f.data.length })) })));
  expect(r.status).toBe(201);
  return r.json as { id: string; pieceBytes: number };
}

/** PUT one request's worth of pieces: [file index, offset, bytes]. */
function piecesForm(pieces: [number, number, Buffer][]): FormData {
  const form = new FormData();
  for (const [index, offset, bytes] of pieces) { form.append("index", String(index)); form.append("offset", String(offset)); form.append("data", new Blob([new Uint8Array(bytes)]), "piece"); }
  return form;
}
const put = async (id: string, pieces: [number, number, Buffer][]) => read(await putPieces(new Request("http://localhost/", { method: "PUT", body: piecesForm(pieces) }), ctx(id)));
const finish = async (id: string) => read(await finishSession(new Request("http://localhost/", { method: "POST" }), ctx(id)));

/** Send files the way the browser does: small ones together, large ones in ordered pieces. */
async function sendAll(id: string, files: { data: Buffer }[], pieceBytes: number) {
  for (const [i, f] of files.entries()) {
    if (f.data.length === 0) continue;
    for (let off = 0; off < f.data.length; off += pieceBytes) expect((await put(id, [[i, off, f.data.subarray(off, off + pieceBytes)]])).status).toBe(200);
  }
}

describe("uploads of any size arrive in pieces and are ingested from disk", () => {
  it("assembles a folder sent in pieces, including a file larger than one piece, and removes the staged copy", async () => {
    const big = Buffer.alloc(UPLOAD_PIECE_BYTES + 5_000, 0x61); // larger than one piece, so it arrives in two
    const files = [
      { path: "shop/src/a.ts", data: Buffer.from("export const a = 1;\n") },
      { path: "shop/assets/big.txt", data: big },
      { path: "shop/empty.txt", data: Buffer.alloc(0) },
      { path: "shop/node_modules/x/index.js", data: Buffer.from("module.exports = 1;\n") },
    ];
    const s = await start("folder", files);
    expect(s.pieceBytes).toBe(UPLOAD_PIECE_BYTES);
    expect(fs.existsSync(path.join(stagingRoot(), s.id))).toBe(true);
    await sendAll(s.id, files, s.pieceBytes);
    const done = await finish(s.id);
    expect(done.status).toBe(201);
    expect(done.json.jobId).toBeTruthy();
    const project = getDb().select().from(schema.projects).where(eq(schema.projects.id, done.json.project.id)).get()!;
    expect(project.name).toBe("shop");
    const rows = getDb().select().from(schema.files).where(eq(schema.files.projectId, project.id)).all();
    expect(rows.map((r) => r.path).sort()).toEqual(["assets/big.txt", "empty.txt", "node_modules/x/index.js", "src/a.ts"]);
    // The large file is kept as metadata with the hash of every byte; small text is stored and readable.
    const bigRow = rows.find((r) => r.path === "assets/big.txt")!;
    expect(bigRow).toMatchObject({ size: big.length, hash: sha256(big), hasContent: false });
    const a = rows.find((r) => r.path === "src/a.ts")!;
    expect(a.hasContent).toBe(true);
    expect(getDb().select().from(schema.blobs).where(eq(schema.blobs.hash, a.hash)).get()?.content).toBe("export const a = 1;\n");
    expect(rows.find((r) => r.path === "node_modules/x/index.js")!.isExcluded).toBe(true);
    expect(fs.existsSync(path.join(stagingRoot(), s.id))).toBe(false);
  });

  it("checks the limits before any byte is sent", async () => {
    const saved = { bytes: config.limits.maxUploadBytes, files: config.limits.maxFiles };
    try {
      config.limits.maxUploadBytes = 1000;
      const tooBig = await read(await createSession(jsonReq({ mode: "folder", files: [{ path: "p/a.ts", size: 600 }, { path: "p/b.ts", size: 600 }] })));
      expect(tooBig.status).toBe(413);
      expect(tooBig.json.error.code).toBe("upload_too_large");
      config.limits.maxUploadBytes = saved.bytes;
      config.limits.maxFiles = 2;
      const tooMany = await read(await createSession(jsonReq({ mode: "files", files: [1, 2, 3].map((i) => ({ path: `f${i}.ts`, size: 1 })) })));
      expect(tooMany.status).toBe(413);
      expect(tooMany.json.error.code).toBe("repo_too_large");
    } finally { config.limits.maxUploadBytes = saved.bytes; config.limits.maxFiles = saved.files; }
    expect((await read(await createSession(jsonReq({ mode: "files", files: [] })))).json.error.code).toBe("empty_upload");
    expect((await read(await createSession(jsonReq({ mode: "zip", files: [{ path: "a.zip", size: 1 }, { path: "b.zip", size: 1 }] })))).json.error.code).toBe("bad_upload");
    expect((await read(await createSession(jsonReq({ mode: "weird", files: [{ path: "a", size: 1 }] })))).json.error.code).toBe("invalid_request");
    expect((await read(await createSession(jsonReq({ mode: "folder", previous: "prj_gone", files: [{ path: "a", size: 1 }] })))).json.error.code).toBe("project_not_found");
  });

  it("the default limit is 10 GB", () => {
    expect(config.limits.maxUploadBytes).toBe(10 * 1024 ** 3);
    expect(config.limits.maxTotalBytes).toBeGreaterThanOrEqual(config.limits.maxUploadBytes);
  });

  it("accepts a retried piece, but refuses pieces that do not match the description or leave a gap", async () => {
    const data = Buffer.from("export const a = 1;\n");
    const s = await start("files", [{ path: "a.ts", data }]);
    expect((await put(s.id, [[0, 0, data.subarray(0, 10)]])).status).toBe(200);
    expect((await put(s.id, [[0, 0, data.subarray(0, 10)]])).status).toBe(200); // a retry after a dropped response
    expect((await put(s.id, [[0, 15, data.subarray(15)]])).json.error.code).toBe("upload_out_of_order");
    expect((await put(s.id, [[1, 0, data]])).json.error.code).toBe("invalid_upload");
    expect((await put(s.id, [[0, 10, Buffer.alloc(100)]])).json.error.code).toBe("invalid_upload");
    expect((await put(s.id, [[0, 10, data.subarray(10)]])).status).toBe(200);
    expect((await finish(s.id)).status).toBe(201);
  });

  it("refuses to finish an upload with missing bytes, and ends the session", async () => {
    const data = Buffer.from("export const a = 1;\n");
    const s = await start("files", [{ path: "a.ts", data }, { path: "b.ts", data }]);
    await put(s.id, [[0, 0, data]]);
    const r = await finish(s.id);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("upload_incomplete");
    expect(r.json.error.message).toContain("b.ts");
    expect((await finish(s.id)).json.error.code).toBe("upload_expired");
  });

  it("never treats a session id as a path", async () => {
    for (const id of ["../../etc", "up_../x", "prj_abc"]) {
      expect((await put(id, [[0, 0, Buffer.from("x")]])).json.error.code).toBe("upload_expired");
      expect((await finish(id)).json.error.code).toBe("upload_expired");
    }
  });

  it("ingests a ZIP sent in pieces, extracting it on disk", async () => {
    const zip = makeZip([{ name: "repo-main/" }, { name: "repo-main/main.go", data: "package main\nfunc main() {}\n" }, { name: "repo-main/go.mod", data: "module x\n" }]);
    const s = await start("zip", [{ path: "repo.zip", data: zip }]);
    await sendAll(s.id, [{ data: zip }], 100); // tiny pieces: many ordered writes into one file
    const done = await finish(s.id);
    expect(done.status).toBe(201);
    const rows = getDb().select().from(schema.files).where(eq(schema.files.projectId, done.json.project.id)).all();
    expect(rows.map((r) => r.path).sort()).toEqual(["go.mod", "main.go"]);
  });

  it("cancelling frees the disk space; stale sessions are swept", async () => {
    const s = await start("files", [{ path: "a.ts", data: Buffer.from("x") }]);
    expect((await read(await cancelSession(new Request("http://localhost/", { method: "DELETE" }), ctx(s.id)))).status).toBe(200);
    expect(fs.existsSync(path.join(stagingRoot(), s.id))).toBe(false);
    const t = await start("files", [{ path: "a.ts", data: Buffer.from("x") }]);
    expect(await sweepStaging(60_000)).not.toContain(t.id);
    const old = new Date(Date.now() - 2 * 60_000);
    fs.utimesSync(path.join(stagingRoot(), t.id), old, old);
    expect(await sweepStaging(60_000)).toContain(t.id);
  });
});

describe("staged normalization matches in-memory normalization", () => {
  it("produces the same file model for the sample project, without holding text in the result", async () => {
    const raw = fixtureFiles();
    const dir = fs.mkdtempSync(path.join(stagingRoot() + "-test"));
    try {
      const staged = raw.map((f, i) => { const file = path.join(dir, String(i)); fs.writeFileSync(file, f.content); return { path: f.path, size: f.content.length, file }; });
      const memory = normalizeFiles(raw);
      const disk = await normalizeStagedFiles(staged);
      const strip = (f: object) => ({ ...f, text: undefined, image: undefined }); // staged ingestion stores both in the database instead
      expect(disk.files.map(strip)).toEqual(memory.files.map(strip));
      expect(disk.stats).toEqual(memory.stats);
      expect(disk.files.every((f) => f.text === undefined)).toBe(true);
      // Every text file's content went to the blob table as it was read.
      for (const f of memory.files.filter((x) => x.text !== undefined)) expect(getDb().select().from(schema.blobs).where(eq(schema.blobs.hash, f.hash)).get()?.content).toBe(f.text);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
