// Private document bytes. AES-256-GCM when stored, plaintext on an authorized download.
// The key comes from LEDGERLY_DOCUMENT_KEY. Without that variable the process uses a
// development key that is not a production secret.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("LLENC1");

export function documentKey() {
  const configured = String(process.env.LEDGERLY_DOCUMENT_KEY || "");
  return createHash("sha256").update(configured || "ledgerly-development-document-key").digest();
}

export function usingDevelopmentDocumentKey() {
  return !String(process.env.LEDGERLY_DOCUMENT_KEY || "");
}

export function sealDocument(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", documentKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

export function revealDocument(stored) {
  const bytes = Buffer.from(stored || "");
  if (bytes.length < MAGIC.length + 28 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) return bytes;
  const iv = bytes.subarray(6, 18);
  const tag = bytes.subarray(18, 34);
  const ciphertext = bytes.subarray(34);
  const decipher = createDecipheriv("aes-256-gcm", documentKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function scanDocument(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  if (text.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) return "This file did not pass the content check.";
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return "This file did not pass the content check.";
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return "This file did not pass the content check.";
  return "";
}
