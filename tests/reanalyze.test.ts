import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "@/lib/db/client";
import { drainQueue } from "@/lib/jobs/worker";
import { GET as plan, POST as reanalyze } from "@/app/api/projects/[id]/analyze/route";
import { POST as upload } from "@/app/api/projects/upload/route";
import { freshDb } from "./helpers";
import { makeZip } from "./helpers/zip";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (init?: RequestInit) => new Request("http://localhost/", init);
const project = (id: string) => getDb().select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;

function folderForm(root: string, files: Record<string, string>, extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("mode", "folder");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  for (const [p, text] of Object.entries(files)) { f.append("files", new File([text], p.split("/").pop()!)); f.append("paths", `${root}/${p}`); }
  return f;
}

const V1 = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "README.md": "# Shop\n" };

describe("Re-analyze for uploaded projects", () => {
  let v1 = "";
  beforeAll(async () => {
    freshDb();
    v1 = (await (await upload(req({ method: "POST", body: folderForm("shop", V1) }))).json()).project.id;
    await drainQueue();
    expect(project(v1).status).toBe("ready");
  }, 60_000);

  it("tells the client an uploaded project is a snapshot that needs the updated code", async () => {
    const r = await (await plan(req(), ctx(v1))).json();
    expect(r).toMatchObject({ source: "upload", sourceType: "folder" });
  });

  it("links a re-upload to the version it updates, keeping the name, even as a differently named ZIP", async () => {
    const zip = makeZip([{ name: "shop-v2/src/a.ts", data: "export const a = 10;\n" }, { name: "shop-v2/src/c.ts", data: "export const c = 3;\n" }, { name: "shop-v2/README.md", data: "# Shop\n" }]);
    const f = new FormData();
    f.set("mode", "zip");
    f.set("previous", v1);
    f.append("files", new File([new Uint8Array(zip)], "shop-v2.zip"));
    f.append("paths", "shop-v2.zip");
    const res = await upload(req({ method: "POST", body: f }));
    expect(res.status).toBe(201);
    const v2 = project((await res.json()).project.id);
    expect(v2.name).toBe("shop");
    expect(v2.previousProjectId).toBe(v1);
    expect(v2.incremental).toMatchObject({ changed: 1, added: 1, removed: 1, unchanged: 1 });
  });

  it("rejects a re-upload for a project that no longer exists", async () => {
    const res = await upload(req({ method: "POST", body: folderForm("shop", V1, { previous: "prj_gone" }) }));
    expect(res.status).toBe(404);
  });

  it("still re-runs the same snapshot when asked", async () => {
    const res = await reanalyze(req({ method: "POST" }), ctx(v1));
    expect(res.status).toBe(202);
    expect(project(v1).status).toBe("analyzing");
    await drainQueue();
    expect(project(v1).status).toBe("ready");
  });
});
