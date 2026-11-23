import { createPublicKey } from "node:crypto";
import { fingerprintOfPublicKeyDer } from "@room/protocol";
import { ValidationError } from "./errors.js";

export interface NormalizedAgentKey {
  /** Canonical SPKI PEM, so equal keys always produce the same stored text. */
  readonly publicKey: string;
  /** SHA-256 of the SPKI DER, hex. This is the key's long-lived identity. */
  readonly fingerprint: string;
}

/**
 * Accepts an Ed25519 public key PEM, validates it and derives the fingerprint
 * from the SPKI DER (plan §8.4). RSA/EC keys are rejected rather than silently
 * accepted, and a malformed PEM never reaches the database.
 */
export function normalizeEd25519PublicKey(pem: string): NormalizedAgentKey {
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new ValidationError("publicKey is not a valid PEM public key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new ValidationError("publicKey must be an Ed25519 key");
  }
  const der = key.export({ type: "spki", format: "der" });
  const canonical = key.export({ type: "spki", format: "pem" }).toString();
  return {
    publicKey: canonical,
    fingerprint: fingerprintOfPublicKeyDer(Buffer.from(der)),
  };
}
