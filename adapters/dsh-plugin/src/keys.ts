import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { publicKeyFingerprint } from "@room/agent-sdk";

export interface AgentKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  fingerprint: string;
  keyPath: string;
}

/**
 * Loads a local Ed25519 private key. The key never leaves this machine and is
 * never written to logs or the plugin configuration. Files with group/other
 * permissions are refused instead of silently trusted.
 */
export async function loadAgentKey(keyPath: string): Promise<AgentKeyPair> {
  const info = await stat(keyPath);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`agent key ${keyPath} must not be readable by group/other (chmod 600)`);
  }
  const pem = await readFile(keyPath, "utf8");
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`agent key ${keyPath} is not an Ed25519 key`);
  }
  return {
    privateKey,
    publicKey: createPublicKey(privateKey),
    fingerprint: publicKeyFingerprint(createPublicKey(privateKey)),
    keyPath,
  };
}

/**
 * Generates a new Ed25519 key pair when no key exists yet; existing keys are
 * loaded unchanged so an installed plugin keeps a stable Agent identity.
 */
export async function ensureAgentKey(keyPath: string): Promise<AgentKeyPair> {
  try {
    return await loadAgentKey(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await writeFile(keyPath, pem, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  return loadAgentKey(keyPath);
}
