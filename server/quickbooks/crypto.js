import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SALT = "ledgerly-quickbooks-oauth-v1";

function keyFor(secret) {
  return scryptSync(String(secret), SALT, 32);
}

export function encryptToken(plaintext, secret) {
  if (!secret || typeof plaintext !== "string" || !plaintext) {
    throw Object.assign(new Error("Token encryption is unavailable."), { status: 500 });
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptToken(stored, secret) {
  const parts = String(stored || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !secret) return "";
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || !tag.length || !ciphertext.length) return "";
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
