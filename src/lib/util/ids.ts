import { randomUUID, createHash } from "node:crypto";

export function newId(prefix?: string): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 20);
  return prefix ? `${prefix}_${id}` : id;
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string | Buffer): string {
  return sha256(input).slice(0, 16);
}
