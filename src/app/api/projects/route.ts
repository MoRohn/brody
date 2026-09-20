import { desc } from "drizzle-orm";
import { guard, json, projectSummary } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(() => {
    const rows = getDb().select().from(schema.projects).orderBy(desc(schema.projects.createdAt)).limit(100).all();
    return json({ projects: rows.map(projectSummary) });
  });
}
