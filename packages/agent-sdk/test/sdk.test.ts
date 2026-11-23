import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { buildAgentChallengeString, fingerprintOfPublicKeyDer } from "@room/protocol";
import { describe, expect, it } from "vitest";
import { publicKeyFingerprint, signChallenge } from "../src/index.js";

function pair() {
  const keys = generateKeyPairSync("ed25519");
  return keys;
}

const challenge = {
  serverId: "srv_1",
  challengeId: "chl_1",
  nonce: "n".repeat(64),
  clientNonce: "c".repeat(16),
  agentId: "agt_1",
  keyFingerprint: "",
  expiresAt: 1_700_000_000_000,
  purpose: "agent-connect",
  protocolVersion: 1,
};

describe("agent sdk signer", () => {
  it("derives the same fingerprint the server derives from SPKI DER", () => {
    const keys = pair();
    const der = keys.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    expect(publicKeyFingerprint(keys.publicKey)).toBe(fingerprintOfPublicKeyDer(der));
    expect(publicKeyFingerprint(keys.publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs the canonical challenge string in a way the room can verify", () => {
    const keys = pair();
    const fields = { ...challenge, keyFingerprint: publicKeyFingerprint(keys.publicKey) };
    const signature = signChallenge(keys.privateKey, fields);
    const canonical = buildAgentChallengeString(fields);
    expect(
      verifySignature(
        null,
        Buffer.from(canonical, "utf8"),
        keys.publicKey,
        Buffer.from(signature, "base64"),
      ),
    ).toBe(true);
  });

  it("refuses a signature from a different key", () => {
    const keys = pair();
    const impostor = pair();
    const fields = { ...challenge, keyFingerprint: publicKeyFingerprint(keys.publicKey) };
    const canonical = buildAgentChallengeString(fields);
    const signature = signChallenge(impostor.privateKey, fields);
    expect(
      verifySignature(
        null,
        Buffer.from(canonical, "utf8"),
        keys.publicKey,
        Buffer.from(signature, "base64"),
      ),
    ).toBe(false);
  });
});
