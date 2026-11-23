/**
 * Minimal Agent for manual end-to-end checks (plan §9 "SDK Mock Agent").
 *
 *   ROOM_URL=http://127.0.0.1:8787 \
 *   AGENT_KEY_FILE=./data/mock-agent-key.pem \
 *   DEV_ADMIN_USER_ID=usr_... \
 *   pnpm exec tsx packages/agent-sdk/scripts/mock-agent.ts
 *
 * With DEV_ADMIN_USER_ID set, the key is registered through the dev-auth API on
 * first use; the server still derives the Agent identity from the key.
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { AgentClient } from "../src/index.js";

const baseUrl = process.env.ROOM_URL ?? "http://127.0.0.1:8787";
const keyFile = process.env.AGENT_KEY_FILE;
if (!keyFile) {
  console.error("AGENT_KEY_FILE is required (PKCS8 Ed25519 private key PEM)");
  process.exit(1);
}
const privateKey = createPrivateKey(readFileSync(keyFile));
const publicKey = createPublicKey(privateKey);
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const client = new AgentClient({
  baseUrl,
  privateKey,
  publicKey,
  onEvent: (event) => {
    console.log(`[event] ${event.eventType} ${event.eventId}`);
    console.log(JSON.stringify(event.payload, null, 2));
  },
});

async function register(adminUserId: string): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dev-user-id": adminUserId },
    body: JSON.stringify({
      displayName: process.env.AGENT_NAME ?? "mock-agent",
      runtime: "mock-agent",
      capabilities: ["echo"],
      publicKey: publicPem,
    }),
  });
  if (!response.ok) {
    throw new Error(`agent registration failed (${response.status}): ${await response.text()}`);
  }
  console.log("[mock-agent] registered a new agent key");
}

const run = async (): Promise<void> => {
  let session;
  try {
    session = await client.connect();
  } catch (error) {
    const admin = process.env.DEV_ADMIN_USER_ID;
    if (!admin) throw error;
    await register(admin);
    session = await client.connect();
  }
  console.log(`[mock-agent] connected as ${session.agentId} (${session.displayName})`);
  const hello = await client.open();
  console.log(
    `[mock-agent] hello: heartbeat=${hello.heartbeatMs}ms outstanding=${hello.outstanding}`,
  );
  process.once("SIGINT", () => {
    client.setStatus("offline");
    client.close();
    process.exit(0);
  });
};

void run().catch((error: unknown) => {
  console.error("[mock-agent]", error);
  process.exit(1);
});
