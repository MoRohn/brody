import { Pool } from "pg";
import { config } from "../config";

export const pool = new Pool({ connectionString: config.databaseUrl });

/** Run a parameterised query and return the rows. */
export async function query(text: string, params: unknown[] = []) {
  const res = await pool.query(text, params);
  return res.rows;
}
