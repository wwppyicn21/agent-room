import { createHash } from "node:crypto";

/**
 * SHA-256 over the DER-encoded SPKI public key, lowercase hex. This is the
 * fingerprint administrators see and Agents sign challenges with; one
 * implementation for Server, SDK and mock agents (plan §8.2/§8.3).
 */
export function fingerprintOfPublicKeyDer(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}
