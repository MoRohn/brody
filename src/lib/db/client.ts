import Database from "better-sqlite3";
import { Column, getTableColumns, getTableName } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { config } from "../config";

export type Db = BetterSQLite3Database<typeof schema>;

interface DbHolder {
  db?: Db;
  sqlite?: Database.Database;
  path?: string;
}

const holder: DbHolder = ((globalThis as unknown as { __brodyDb?: DbHolder }).__brodyDb ??= {});

/** Resolve the migrations folder for both source and standalone builds. */
function migrationsFolder(): string {
  const candidates = [
    path.join(process.cwd(), "drizzle"),
    path.join(process.cwd(), "..", "drizzle"),
    path.resolve(__dirname, "../../../drizzle"),
    path.resolve(__dirname, "../../../../drizzle"),
  ];
  // brody-ignore: sync-io  (runs once at startup)
  for (const c of candidates) if (fs.existsSync(path.join(c, "meta", "_journal.json"))) return c;
  throw new Error(`Database migrations folder not found. Looked in: ${candidates.join(", ")}`);
}

export function openDatabase(dbPath: string = config.databasePath): Db {
  if (holder.db && holder.path === dbPath) return holder.db;
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  // WAL makes synchronous=NORMAL safe (a crash can lose the last commit, never corrupt the file) and removes an fsync from every commit.
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("temp_store = MEMORY");
  sqlite.pragma("cache_size = -65536"); // 64 MB page cache
  sqlite.pragma("mmap_size = 268435456"); // let reads of a large project come straight from the OS page cache
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  holder.db = db;
  holder.sqlite = sqlite;
  holder.path = dbPath;
  return db;
}

/** Return the open database, opening the configured one on first use. */
export function getDb(): Db {
  return holder.db ?? openDatabase();
}

const onDatabaseClosed: (() => void)[] = [];
/** Register cleanup for caches that must not outlive the open database (tests open and close many). */
export function onClose(fn: () => void): void { onDatabaseClosed.push(fn); }

export function closeDatabase(): void {
  holder.sqlite?.close();
  statements.delete(holder.sqlite as Database.Database);
  onDatabaseClosed.forEach((fn) => fn());
  holder.db = undefined;
  holder.sqlite = undefined;
  holder.path = undefined;
}

export { schema };

// ---------------------------------------------------------------------------
// Bulk access. Drizzle rebuilds SQL and re-inspects every column for every row it writes or maps, which dominated the
// analysis profile. These helpers prepare one statement per table and reuse Drizzle's own column encoders and decoders,
// so the values stored and returned are identical; only the per-row overhead is gone.
// ---------------------------------------------------------------------------
export function getSqlite(): Database.Database {
  getDb();
  return holder.sqlite!;
}

type Prepared = Map<string, unknown>;
const statements = new WeakMap<Database.Database, Prepared>();
function prepared<T>(key: string, make: () => T): T {
  const sqlite = getSqlite();
  let m = statements.get(sqlite);
  if (!m) statements.set(sqlite, (m = new Map()));
  let v = m.get(key) as T | undefined;
  if (v === undefined) { v = make(); m.set(key, v); }
  return v;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * A table or column name as a quoted SQL identifier. Names come from the Drizzle schema, never from a request, and values are
 * always bound as `?` parameters. The name is still validated here, so a future misuse cannot put arbitrary text into a statement.
 */
export function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Refusing to use ${JSON.stringify(name)} as a SQL identifier.`);
  return `"${name}"`;
}
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The statements the bulk helpers run, built from validated identifiers only. Exported so they can be tested directly. */
export const sqlText = {
  insert: (table: string, columns: string[], ignoreConflicts: boolean): string => ["INSERT", ignoreConflicts ? "OR IGNORE" : "", "INTO", ident(table), `(${columns.map(ident).join(", ")})`, "VALUES", `(${placeholders(columns.length)})`].filter(Boolean).join(" "),
  update: (table: string, set: string[], where: string[]): string => ["UPDATE", ident(table), "SET", set.map((c) => `${ident(c)} = ?`).join(", "), "WHERE", where.map((c) => `${ident(c)} = ?`).join(" AND ")].join(" "),
  select: (table: string, columns: string[], whereColumn: string): string => ["SELECT", columns.map(ident).join(", "), "FROM", ident(table), "WHERE", `${ident(whereColumn)} = ?`].join(" "),
};

const identityDecode = Column.prototype.mapFromDriverValue;
type Cols = { key: string; column: Column; name: string }[];
const columnsOf = (table: SQLiteTable): Cols => Object.entries(getTableColumns(table)).map(([key, column]) => ({ key, column, name: column.name }));

/** A value as Drizzle would bind it, including column defaults for omitted fields. */
function encode(c: { column: Column }, v: unknown): unknown {
  if (v === undefined) {
    const col = c.column as Column & { defaultFn?: () => unknown; onUpdateFn?: () => unknown };
    if (col.defaultFn) v = col.defaultFn();
    else if (col.hasDefault && col.default !== undefined) v = col.default;
    else return null;
  }
  return v === null ? null : c.column.mapToDriverValue(v);
}

/** Insert many rows with one prepared statement inside one transaction. */
export function bulkInsert<T extends SQLiteTable>(table: T, rows: T["$inferInsert"][], opts: { ignoreConflicts?: boolean } = {}): void {
  if (rows.length === 0) return;
  const cols = columnsOf(table);
  const stmt = prepared(`insert:${opts.ignoreConflicts ? "ignore:" : ""}${getTableName(table)}`, () =>
    getSqlite().prepare(sqlText.insert(getTableName(table), cols.map((c) => c.name), !!opts.ignoreConflicts)));
  const run = getSqlite().transaction((batch: Record<string, unknown>[]) => {
    for (const r of batch) stmt.run(cols.map((c) => encode(c, r[c.key])));
  });
  run(rows as Record<string, unknown>[]);
}

/** Update the same columns on many rows, matched by `where` columns, with one prepared statement inside one transaction. */
export function bulkUpdate<T extends SQLiteTable>(table: T, where: (keyof T["$inferSelect"] & string)[], set: (keyof T["$inferSelect"] & string)[], rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const all = columnsOf(table);
  const pick = (keys: string[]) => keys.map((k) => all.find((c) => c.key === k)!);
  const setCols = pick(set);
  const whereCols = pick(where);
  const stmt = prepared(`update:${getTableName(table)}:${set.join(",")}:${where.join(",")}`, () =>
    getSqlite().prepare(sqlText.update(getTableName(table), setCols.map((c) => c.name), whereCols.map((c) => c.name))));
  const run = getSqlite().transaction((batch: Record<string, unknown>[]) => {
    for (const r of batch) stmt.run([...setCols.map((c) => encode(c, r[c.key])), ...whereCols.map((c) => encode(c, r[c.key]))]);
  });
  run(rows);
}

/** Every row of a table for one project, decoded exactly as `db.select().from(table).where(projectId = ...)` would. */
export function projectRows<T extends SQLiteTable>(table: T, projectId: string): T["$inferSelect"][] {
  const cols = columnsOf(table);
  const name = getTableName(table);
  const projectCol = cols.find((c) => c.key === "projectId");
  if (!projectCol) throw new Error(`Table ${name} has no projectId column`);
  const stmt = prepared(`select:${name}`, () => getSqlite().prepare(sqlText.select(name, cols.map((c) => c.name), projectCol.name)).raw(true));
  const decoders = prepared(`decoders:${name}`, () => cols.map((c) => (c.column.mapFromDriverValue !== identityDecode ? (c.column.mapFromDriverValue.bind(c.column) as (v: unknown) => unknown) : null)));
  const keys = cols.map((c) => c.key);
  const rows = (stmt as Database.Statement).all(projectId) as unknown[][];
  const out = new Array<Record<string, unknown>>(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const o: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const v = row[i];
      const d = decoders[i];
      o[keys[i]] = v === null || d === null ? v : d(v);
    }
    out[r] = o;
  }
  return out as T["$inferSelect"][];
}
