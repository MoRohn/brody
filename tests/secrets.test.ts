import { describe, expect, it } from "vitest";
import { detectSecrets, redactSecrets } from "@/lib/ingest/secrets";
import { decryptSecret, encryptSecret, scrubToken } from "@/lib/ingest/credentials";

const AWS = "AKIAJ4Q7ZK3M2WXN5PTB";
const GH = "ghp_" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3kL6";
const STRIPE = "sk_live_" + "51H8xYz2eZvKYlo2C0aBcDeFg";

describe("secret detection and redaction", () => {
  it("detects common credential formats with line numbers and masked previews", () => {
    const text = `const a = 1;\nconst aws = "${AWS}";\nconst gh = "${GH}";\nconst stripe = "${STRIPE}";\n-----BEGIN RSA PRIVATE KEY-----\nDATABASE = "postgres://admin:hunter2secret@db.prod.acme-internal.io:5432/app"\npassword = "s3cr3t-passw0rd-value"`;
    const found = detectSecrets(text, "config.ts");
    const kinds = found.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["AWS Access Key", "GitHub Token", "Stripe Key", "Private Key", "Connection String", "Password Assignment"]));
    expect(found.find((f) => f.kind === "AWS Access Key")!.line).toBe(2);
    for (const f of found) { expect(f.preview).not.toContain(AWS); expect(f.preview).not.toContain(GH); expect(f.preview).not.toContain("hunter2secret"); }
  });

  it("ignores placeholders, env lookups, template files and localhost connection strings", () => {
    expect(detectSecrets(`api_key = "your-api-key-here-1234"`, "a.py")).toHaveLength(0);
    expect(detectSecrets(`const k = process.env.STRIPE_SECRET_KEY;`, "a.ts")).toHaveLength(0);
    expect(detectSecrets(`STRIPE_KEY=sk_live_${"x".repeat(24)}`, ".env.example")).toHaveLength(0);
    expect(detectSecrets(`DATABASE_URL=postgres://shop:pw123456@localhost:5432/shop`, "a.env")).toHaveLength(0);
    expect(detectSecrets(`password = "changeme-changeme"`, "a.ts")).toHaveLength(0);
  });

  it("redacts secrets from model-bound text and leaves ordinary code intact", () => {
    const src = `const key = "${AWS}";\nconst n = 42; // keep me`;
    const out = redactSecrets(src);
    expect(out).not.toContain(AWS);
    expect(out).toContain("[REDACTED_SECRET]");
    expect(out).toContain("const n = 42; // keep me");
    expect(redactSecrets(`Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456`)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("encrypts stored credentials (AES-GCM) and scrubs tokens from log text", () => {
    const enc = encryptSecret(GH);
    expect(enc).not.toContain(GH);
    expect(decryptSecret(enc)).toBe(GH);
    expect(decryptSecret(enc.slice(0, -4) + "AAAA")).toBeUndefined();
    const scrubbed = scrubToken(`request to https://api.github.com failed with ${GH} and Authorization: Bearer abc.def-ghi`);
    expect(scrubbed).not.toContain(GH);
    expect(scrubbed).not.toContain("abc.def-ghi");
  });
});
