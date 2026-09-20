import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
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

export function closeDatabase(): void {
  holder.sqlite?.close();
  holder.db = undefined;
  holder.sqlite = undefined;
  holder.path = undefined;
}

export { schema };
