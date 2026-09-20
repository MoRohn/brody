import { describe, expect, it } from "vitest";
import { parseFile } from "@/lib/parse";

const names = (r: Awaited<ReturnType<typeof parseFile>>) => r.symbols.map((s) => `${s.kind}:${s.qualifiedName}`);

describe("AST parsing and symbol extraction", () => {
  it("extracts TypeScript/TSX symbols, imports, exports, inheritance and inline route handlers", async () => {
    const src = `import { x } from './x';
import React, { useState } from 'react';
import type { T } from './t';
const db = require('pg');
/** Doc for f */
export function f(a: number) { if (a) return g(a) && x(); return 1; }
export const Comp = () => { const [s] = useState(1); return <div>{f(1)}</div>; };
export const useThing = () => 1;
export class UserService extends Base implements IThing { private go() { this.repo.save(); } }
export const users = sqliteTable('users', {});
router.get('/health', async (req, res) => { res.json(f(1)); });
export { a as b } from './c';
`;
    const r = await parseFile("src/a.tsx", "TypeScript", src);
    expect(r.status).toBe("ast");
    const n = names(r);
    expect(n).toContain("function:f");
    expect(n).toContain("component:Comp");
    expect(n).toContain("hook:useThing");
    expect(n).toContain("service:UserService");
    expect(n).toContain("method:UserService.go");
    expect(n).toContain("model:users");
    expect(n).toContain("endpoint:GET /health");
    expect(r.symbols.find((s) => s.name === "f")!.documentation).toBe("Doc for f");
    expect(r.imports.map((i) => i.specifier)).toEqual(expect.arrayContaining(["./x", "react", "./t", "pg", "./c"]));
    expect(r.imports.find((i) => i.specifier === "./t")!.isTypeOnly).toBe(true);
    expect(r.exports).toEqual(expect.arrayContaining(["f", "Comp", "useThing", "UserService", "b"]));
    expect(r.inheritance.filter((i) => i.parentName === "Base" && i.kind === "EXTENDS")).toHaveLength(1);
    expect(r.inheritance.some((i) => i.parentName === "IThing" && i.kind === "IMPLEMENTS")).toBe(true);
    // Calls inside the inline handler are attributed to the endpoint symbol, not the file.
    const ep = r.symbols.find((s) => s.kind === "endpoint")!;
    expect(r.calls.filter((c) => c.name === "f" && c.callerIndex === ep.index).length).toBeGreaterThan(0);
    expect(r.complexity.get(r.symbols.find((s) => s.name === "f")!.index)).toBeGreaterThanOrEqual(3);
  });

  it("extracts Python symbols, decorated routes, docstrings and relative imports", async () => {
    const r = await parseFile("app/main.py", "Python", `import os\nfrom fastapi import FastAPI\nfrom .models import User\napp = FastAPI()\n\n@app.get('/users')\ndef list_users():\n    """List users."""\n    return db.query(User).all()\n\nclass UserRepo(Base):\n    def save(self, u):\n        if u: self.session.add(u)\n`);
    expect(names(r)).toEqual(expect.arrayContaining(["service:app", "endpoint:list_users", "method:UserRepo.save"]));
    expect(r.symbols.find((s) => s.name === "list_users")!.documentation).toBe("List users.");
    expect(r.imports.map((i) => i.specifier)).toEqual(expect.arrayContaining(["os", "fastapi", ".models"]));
    expect(r.inheritance).toEqual([expect.objectContaining({ parentName: "Base", kind: "EXTENDS" })]);
  });

  it("extracts Go, Java, C#, Ruby, Rust and PHP", async () => {
    const go = await parseFile("main.go", "Go", `package main\nimport ("fmt"; "net/http")\ntype User struct { ID int \`gorm:"primaryKey"\` }\nfunc (s *UserService) Get(id int) *User { return nil }\nfunc main() { http.HandleFunc("/", nil) }\n`);
    expect(names(go)).toEqual(expect.arrayContaining(["model:User", "function:main"]));
    expect(go.imports.map((i) => i.specifier)).toEqual(["fmt", "net/http"]);
    const java = await parseFile("A.java", "Java", `package x; import java.util.List;\n@RestController public class UserController { @GetMapping("/users") public List<User> list() { return repo.findAll(); } }\n@Entity public class User { private Long id; }\n`);
    expect(names(java)).toEqual(expect.arrayContaining(["service:UserController", "endpoint:UserController.list", "model:User"]));
    const cs = await parseFile("A.cs", "C#", `using System;\nnamespace App { [ApiController] public class UsersController : ControllerBase { [HttpGet("users")] public IActionResult Get() { return Ok(); } } }\n`);
    expect(names(cs)).toEqual(expect.arrayContaining(["service:UsersController"]));
    expect(cs.inheritance.some((i) => i.parentName === "ControllerBase")).toBe(true);
    const rb = await parseFile("a.rb", "Ruby", `require 'json'\nclass User < ApplicationRecord\n  def name; 'x'; end\nend\n`);
    expect(names(rb)).toEqual(expect.arrayContaining(["model:User", "method:User.name"]));
    const rs = await parseFile("a.rs", "Rust", `use std::io;\npub struct User { id: u32 }\nimpl User { pub fn new() -> Self { User { id: 1 } } }\npub fn main() {}\n`);
    expect(names(rs)).toEqual(expect.arrayContaining(["struct:User", "method:User::new", "function:main"]));
    const php = await parseFile("a.php", "PHP", `<?php\nnamespace App;\nuse App\\Models\\User;\nclass UserController extends Controller { public function index() { return User::all(); } }\n`);
    expect(names(php)).toEqual(expect.arrayContaining(["service:UserController", "method:UserController.index"]));
  });

  it("parses SQL columns from the table body only, Prisma models, Markdown headings and compose services", async () => {
    const sql = await parseFile("s.sql", "SQL", `CREATE TABLE users (id serial primary key, name text);\nCREATE TABLE posts (id serial, user_id int references users(id), PRIMARY KEY (id));`);
    expect(sql.symbols.find((s) => s.name === "users")!.meta).toMatchObject({ fields: ["id", "name"] });
    expect(sql.symbols.find((s) => s.name === "posts")!.meta).toMatchObject({ fields: ["id", "user_id"], references: ["users"] });
    const prisma = await parseFile("schema.prisma", "Prisma", `model User { id Int @id\n posts Post[] }\nmodel Post { id Int @id\n author User @relation(fields: [authorId], references: [id])\n authorId Int }`);
    expect(names(prisma)).toEqual(["model:User", "model:Post"]);
    const md = await parseFile("README.md", "Markdown", "# Title\n\n## Setup\ntext\n### Sub\n## Usage");
    expect(md.symbols.map((s) => s.name)).toEqual(["Title", "Setup", "Sub", "Usage"]);
    const yml = await parseFile("docker-compose.yml", "YAML", "services:\n  web:\n    image: node\n  db:\n    image: postgres\n");
    expect(yml.symbols.map((s) => s.name)).toEqual(["services.web", "services.db"].map((x) => x.split(".")[1]).map((x) => (x === "web" ? "web" : "db")));
  });

  it("falls back to text inspection for languages without a grammar and does not claim AST support", async () => {
    const kt = await parseFile("a.kt", "Kotlin", `class Foo : Bar() {\n  fun doIt(x: Int): Int { return x }\n}\nfun main() { doIt(1) }`);
    expect(kt.status).toBe("text");
    expect(kt.parser).toBe("text:generic");
    expect(kt.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["Foo", "doIt", "main"]));
    const unknown = await parseFile("data.zzz", "Unknown", "some opaque text");
    expect(unknown.status).toBe("skipped");
    expect(unknown.symbols).toHaveLength(0);
    const empty = await parseFile("x.ts", "TypeScript", "   \n");
    expect(empty.status).toBe("skipped");
  });

  it("tolerates syntax errors and reports partial extraction", async () => {
    const r = await parseFile("bad.ts", "TypeScript", "export function ok() { return 1; }\nexport function broken( {\n");
    expect(r.status).toBe("ast");
    expect(r.error).toContain("syntax errors");
    expect(r.symbols.some((s) => s.name === "ok")).toBe(true);
  });
});
