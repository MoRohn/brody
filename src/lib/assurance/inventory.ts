import type { Architecture } from "../discover/types";
import { classifyField, compact, SENSITIVITY_ORDER } from "./pii";
import type { PiiField } from "./types";

const modelKey = (name: string) => compact(name).replace(/(ies)$/, "y").replace(/s$/, "");

/**
 * Every personal-data field in the detected data models. A table declared twice (a migration and an ORM model) is listed
 * once, keeping the declaration that says more about protection. `textOf` lets the inventory point at the field's own line.
 */
export function piiInventory(arch: Architecture, textOf?: (path: string) => string | undefined): PiiField[] {
  const out = new Map<string, PiiField>();
  for (const m of arch.models) {
    if (/(^|\/)(tests?|__tests__|spec|fixtures?|mocks?)\//i.test(m.file)) continue;
    const lines = textOf?.(m.file)?.split("\n");
    const types = new Map((m.fieldTypes ?? []).map((f) => [f.name, f.type]));
    for (const field of m.fields) {
      const hit = classifyField(field, m.name, types.get(field) ?? "");
      if (!hit) continue;
      let line = m.line;
      if (lines) {
        const re = new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        for (let i = Math.max(0, m.line - 1); i < Math.min(lines.length, (m.endLine || m.line) + 1); i++) if (re.test(lines[i])) { line = i + 1; break; }
      }
      const row: PiiField = { model: m.name, field, category: hit.category.key, categoryLabel: hit.category.label, sensitivity: hit.category.sensitivity, protection: hit.protection, path: m.file, line };
      const key = `${modelKey(m.name)}:${compact(field).replace(/hash(ed)?|encrypted|digest/g, "")}`;
      const prev = out.get(key);
      if (!prev || (prev.protection === "none" && row.protection !== "none")) out.set(key, row);
    }
  }
  return [...out.values()].sort((a, b) => SENSITIVITY_ORDER.indexOf(a.sensitivity) - SENSITIVITY_ORDER.indexOf(b.sensitivity) || a.model.localeCompare(b.model) || a.field.localeCompare(b.field));
}
