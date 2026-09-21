import type { JobStage } from "../db/schema";

export const STAGE_DEFS: { key: string; label: string }[] = [
  { key: "import", label: "Importing repository" },
  { key: "enumerate", label: "Enumerating files" },
  { key: "parse", label: "Parsing source" },
  { key: "graph", label: "Building symbol and dependency graph" },
  { key: "index", label: "Indexing for retrieval" },
  { key: "architecture", label: "Detecting architecture" },
  { key: "static", label: "Running static analysis" },
  { key: "review", label: "Reviewing code" },
  { key: "verify", label: "Verifying findings" },
  { key: "docs", label: "Generating documentation" },
  { key: "map", label: "Building code map" },
  { key: "deck", label: "Building executive deck" },
  { key: "finalize", label: "Finalizing report" },
];

export function initialStages(): JobStage[] {
  return STAGE_DEFS.map((s) => ({ key: s.key, label: s.label, status: "pending" }));
}
