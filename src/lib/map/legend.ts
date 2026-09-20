/** Single source of truth for map symbols; used by the UI and by every export. */
export type NodeType = "entry" | "service" | "ui" | "api" | "model" | "util" | "external" | "test" | "config" | "job" | "infra";
export type RiskLevel = "critical" | "high" | "medium" | "low" | "none";

export const NODE_LEGEND: { type: NodeType; glyph: string; label: string }[] = [
  { type: "entry", glyph: "●", label: "Application Entry Point" },
  { type: "service", glyph: "◆", label: "Service" },
  { type: "ui", glyph: "■", label: "UI Component" },
  { type: "api", glyph: "▲", label: "API Endpoint" },
  { type: "model", glyph: "⬢", label: "Data Model" },
  { type: "util", glyph: "○", label: "Utility" },
  { type: "external", glyph: "★", label: "External Service" },
  { type: "test", glyph: "T", label: "Test" },
  { type: "config", glyph: "C", label: "Configuration" },
  { type: "job", glyph: "⟳", label: "Background Job" },
  { type: "infra", glyph: "▣", label: "Infrastructure" },
];

export const EDGE_LEGEND: { kind: string; glyph: string; label: string; dash?: string }[] = [
  { kind: "CALLS", glyph: "→", label: "Calls" },
  { kind: "IMPORTS", glyph: "⇢", label: "Imports", dash: "6 3" },
  { kind: "FLOWS", glyph: "⟶", label: "Data flow" },
  { kind: "WRITES_TO", glyph: "⤷", label: "Writes to" },
  { kind: "READS_FROM", glyph: "⤶", label: "Reads from" },
  { kind: "OPTIONAL", glyph: "⋯", label: "Optional dependency", dash: "2 4" },
];

export const RISK_LEGEND: { level: RiskLevel; glyph: string; label: string }[] = [
  { level: "critical", glyph: "!", label: "Critical" },
  { level: "high", glyph: "▲", label: "High" },
  { level: "medium", glyph: "●", label: "Medium" },
  { level: "low", glyph: "○", label: "Low" },
];

export function glyphFor(type: NodeType): string {
  return NODE_LEGEND.find((n) => n.type === type)?.glyph ?? "○";
}

export function riskGlyph(level: RiskLevel): string {
  return RISK_LEGEND.find((r) => r.level === level)?.glyph ?? "";
}

export function legendText(): string {
  return [
    "LEGEND",
    "",
    ...NODE_LEGEND.map((n) => `${n.glyph} ${n.label}`),
    "",
    ...EDGE_LEGEND.map((e) => `${e.glyph} ${e.label}`),
    "",
    "Risk:",
    ...RISK_LEGEND.map((r) => `${r.glyph} ${r.label}`),
  ].join("\n");
}
