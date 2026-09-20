import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "@/lib/db/client";
import type { Architecture } from "@/lib/discover/types";
import { parseTypedFields } from "@/lib/discover/detect";
import { entityNames, erMermaid } from "@/lib/map";
import { analyze, freshDb, fromStrings } from "./helpers";

const REPO = fromStrings({
  "app/schemas.py": `from typing import List, Optional
from pydantic import BaseModel


class Integrity(BaseModel):
    status: str
    signals: List[str]
    hidden_chars_removed: int


class ScoreBand(BaseModel):
    low: float
    high: float
    outcome: str


class RubricInfo(BaseModel):
    id: str
    version: str
    title: str


class EvaluateResponse(BaseModel):
    score: float
    reason: str
    rubric: RubricInfo
    bands: List[ScoreBand]
    integrity: Optional[Integrity] = None
`,
  "legacy/models.py": `from pydantic import BaseModel


class Integrity(BaseModel):
    status: str
    checked_at: str
`,
  "README.md": "# demo\n",
});

let arch: Architecture;
let pid: string;
beforeAll(async () => {
  freshDb();
  pid = (await analyze(REPO, "models")).projectId;
  arch = (getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!.analysis as { architecture: Architecture }).architecture;
});

describe("data model map", () => {
  it("records typed fields", () => {
    const rubric = arch.models.find((m) => m.name === "RubricInfo")!;
    expect(rubric.fieldTypes).toEqual([{ name: "id", type: "str" }, { name: "version", type: "str" }, { name: "title", type: "str" }]);
    const integrity = arch.models.find((m) => m.name === "Integrity" && m.file === "app/schemas.py")!;
    expect(integrity.fieldTypes!.find((f) => f.name === "signals")!.type).toBe("List[str]");
  });

  it("finds relationships from type annotations, with cardinality, even without any foreign key", () => {
    const resp = arch.models.find((m) => m.name === "EvaluateResponse")!;
    const rel = (via: string) => resp.relations!.find((r) => r.via === via)!;
    expect(rel("rubric")).toMatchObject({ targetName: "RubricInfo", cardinality: "one", source: "type-reference" });
    expect(rel("bands")).toMatchObject({ targetName: "ScoreBand", cardinality: "many" });
    expect(rel("integrity")).toMatchObject({ targetName: "Integrity", cardinality: "optional" });
    expect(resp.fieldTypes!.filter((f) => f.relation).map((f) => f.name)).toEqual(["rubric", "bands", "integrity"]);
    expect(resp.references).toEqual(expect.arrayContaining(["RubricInfo", "ScoreBand", "Integrity"]));
  });

  it("points a relation at the right model when two share a name: the same file wins", () => {
    const resp = arch.models.find((m) => m.name === "EvaluateResponse")!;
    const target = resp.relations!.find((r) => r.via === "integrity")!.target;
    expect(target).toBe("app/schemas.py#Integrity");
    expect(arch.models.map((m) => m.id)).toEqual(expect.arrayContaining(["app/schemas.py#Integrity", "legacy/models.py#Integrity"]));
  });

  it("draws every model as an entity with typed attributes, unique names, and cardinality-aware lines", () => {
    const er = erMermaid(pid)!;
    expect(er.startsWith("erDiagram")).toBe(true);
    // All models appear, not only those with relationships.
    for (const n of ["ScoreBand", "RubricInfo", "EvaluateResponse"]) expect(er).toContain(`  ${n} {`);
    // Same-named models get distinct entity names.
    const entities = [...er.matchAll(/^  (\w+) \{$/gm)].map((m) => m[1]);
    expect(new Set(entities).size).toBe(entities.length);
    expect(entities.filter((e) => e.startsWith("Integrity"))).toHaveLength(2);
    // Typed attributes with keys, and relationship lines labelled by the field.
    expect(er).toMatch(/    float score/);
    expect(er).toMatch(/    RubricInfo rubric FK/);
    expect(er).toMatch(/    str id PK|    string id PK/);
    expect(er).toMatch(/EvaluateResponse \|\|--o\{ ScoreBand : "bands"/);
    expect(er).toMatch(/EvaluateResponse \}o--\|\| RubricInfo : "rubric"/);
    expect(er).toMatch(/EvaluateResponse \}o--o\| Integrity_\w+ : "integrity"/);
  });

  it("produces valid Mermaid identifiers for awkward names and types", () => {
    const names = entityNames([{ name: "Line-Item", file: "a/b.ts" }, { name: "3D", file: "c.ts" }, { name: "X", file: "p/q.ts" }, { name: "X", file: "r/q.ts" }]);
    for (const n of names.values()) expect(n).toMatch(/^[A-Za-z_]\w*$/);
    expect(new Set(names.values()).size).toBe(4);
  });

  it("parses typed fields per language", () => {
    expect(parseTypedFields("TypeScript", "export interface Order {\n  id: string;\n  customer: Customer;\n  coupon?: Coupon;\n  items: Item[];\n}")).toEqual([{ name: "id", type: "string" }, { name: "customer", type: "Customer" }, { name: "coupon", type: "Coupon | undefined" }, { name: "items", type: "Item[]" }]);
    expect(parseTypedFields("Go", "type User struct {\n\tID int\n\tOrders []Order\n}")).toEqual([{ name: "ID", type: "int" }, { name: "Orders", type: "[]Order" }]);
    expect(parseTypedFields("C#", "class A {\n public virtual ICollection<Order> Orders { get; set; }\n public int Id { get; set; }\n}").map((f) => f.name)).toEqual(["Orders", "Id"]);
    expect(parseTypedFields("JSON", '{"properties": {"integrity": {"$ref": "#/definitions/Integrity"}, "score": {"type": "number"}}}')).toEqual([{ name: "integrity", type: "Integrity" }, { name: "score", type: "number" }]);
  });
});
