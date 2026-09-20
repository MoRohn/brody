import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { config } from "../config";

/**
 * Credentials are encrypted with AES-256-GCM. When CREDENTIAL_SECRET is not
 * configured a per-process random key is used, which makes stored tokens
 * session scoped: they cannot be recovered after a restart.
 */
const processKey = randomBytes(32);

function key(): Buffer {
  if (config.credentialSecret) return createHash("sha256").update(config.credentialSecret).digest();
  return processKey;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string | undefined {
  try {
    const [iv, tag, data] = payload.split(".");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Scrub anything that looks like a token from a string before it is logged. */
export function scrubToken(message: string): string {
  return message.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[token]").replace(/Bearer\s+\S+/g, "Bearer [token]");
}
