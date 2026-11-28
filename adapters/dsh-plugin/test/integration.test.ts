import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/server/src/app.js";
import { addMember } from "../../../apps/server/src/modules/groups.js";
import { listMessages, postMessage } from "../../../apps/server/src/modules/messages.js";
import { registerAgentWithKey } from "../../../apps/server/src/modules/agents.js";
import {
  createTestRoom,
  seedGroup,
  seedUser,
  type TestRoom,
} from "../../../apps/server/test/helpers.js";
import { RoomBridge, type DshContextLike, type DshSessionEvent } from "../src/bridge.js";

interface Harness {
  room: TestRoom;
  app: Awaited<ReturnType<typeof buildApp>>;
  bridge: RoomBridge;
  prompts: { requestId: string; sessionId: string; content: { type: string; text: string }[] }[];
  emit: (sessionId: string, event: DshSessionEvent) => void;
  groupId: string;
  userId: string;
}

async function setup(): Promise<Harness> {
  const now = () => Date.now();
  const room = createTestRoom(now);
  const admin = seedUser(room.ctx, "admin", "owner");
  const groupId = seedGroup(room.ctx, admin, "bridge");
  const keys = generateKeyPairSync("ed25519");
  const agentId = registerAgentWithKey(room.ctx, {
    displayName: "dsh-plugin",
    runtime: "dsh",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    actorUserId: admin,
  }).agent.id;
  addMember(room.ctx, { groupId, actorUserId: admin, memberType: "agent", memberId: agentId });

  const temp = mkdtempSync(join(tmpdir(), "room-dsh-integration-"));
  const keyPath = join(temp, "agent-key.pem");
  writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    mode: 0o600,
  });

  const app = await buildApp({
    config: loadConfig({ LOG_LEVEL: "silent", AGENT_SESSION_TTL_MS: "60000" }),
    database: room.handle,
    now,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const prompts: Harness["prompts"] = [];
  const listeners: ((session: { id: string }, event: DshSessionEvent) => void)[] = [];
  const ctx: DshContextLike = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (service) => {
      if (service === "sessionController") {
        return {
          prompt: async (request: (typeof prompts)[number]) => {
            prompts.push(request);
            return { accepted: true as const };
          },
          cancel: () => {},
        };
      }
      if (service === "sessionQuery") {
        return { readSession: async () => ({ id: "ok" }) };
      }
      return undefined;
    },
    effect: () => {},
    on: (_name, listener) => {
      listeners.push(listener);
      return () => {};
    },
  };
  const bridge = new RoomBridge(
    {
      enabled: true,
      roomBaseUrl: baseUrl,
      agentKeyPath: keyPath,
      dataDir: temp,
      groups: [{ groupId, sessionId: "ses_bridge", label: "Bridge" }],
    },
    { ctx },
  );
  await bridge.start();
  const deadline = Date.now() + 5_000;
  while (!bridge.status().connected) {
    if (Date.now() > deadline) throw new Error("plugin did not connect");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    room,
    app,
    bridge,
    prompts,
    groupId,
    userId: admin,
    emit: (sessionId, event) => {
      for (const listener of listeners) listener({ id: sessionId }, event);
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("DSH plugin end-to-end", () => {
  it("authenticates, prompts the mapped session, and posts the assistant reply", async () => {
    const harness = await setup();
    try {
      const source = postMessage(harness.room.ctx, {
        groupId: harness.groupId,
        actor: { type: "user", id: harness.userId },
        content: "hello from room",
      });
      await waitFor(() => harness.prompts.length > 0);
      expect(harness.prompts[0]?.sessionId).toBe("ses_bridge");
      expect(harness.prompts[0]?.requestId.startsWith("room-")).toBe(true);
      expect(harness.prompts[0]?.content[0]?.text).toContain("hello from room");

      harness.emit("ses_bridge", {
        type: "user/message",
        data: { turn: 1, source: { rpcId: harness.prompts[0]!.requestId } },
      });
      harness.emit("ses_bridge", {
        type: "assistant/message",
        data: { turn: 1, message: { content: [{ type: "text", text: "hello back" }] } },
      });
      harness.emit("ses_bridge", {
        type: "turn/end",
        data: { turn: 1, reason: { kind: "completed" } },
      });

      const groupMessages = () =>
        listMessages(harness.room.ctx, {
          groupId: harness.groupId,
          viewer: { type: "user", id: harness.userId },
        }).items;
      await waitFor(() =>
        groupMessages().some(
          (message) => message.senderType === "agent" && message.content === "hello back",
        ),
      );
      const reply = groupMessages().find((message) => message.senderType === "agent");
      expect(reply).toMatchObject({ content: "hello back", replyToMessageId: source.id });
    } finally {
      await harness.bridge.stop();
      await harness.app.close();
      harness.room.close();
    }
  });
});
