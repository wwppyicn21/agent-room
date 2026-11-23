import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentChallenges, agentSessions, agentSocketTickets } from "@room/database";
import { loadConfig } from "@room/config";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  MAX_ACTIVE_CHALLENGES_PER_KEY,
  cleanupExpiredChallenges,
  cleanupExpiredSocketTickets,
  createAgentChallenge,
} from "../src/modules/agentAuth.js";
import { registerAgentWithKey } from "../src/modules/agents.js";
import { createTestRoom, seedUser, type TestRoom } from "./helpers.js";

function pair(): { pem: string } {
  return {
    pem: generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString(),
  };
}

const rooms: TestRoom[] = [];

afterEach(() => {
  for (const room of rooms.splice(0)) room.close();
});

function room(now?: () => number): TestRoom {
  const created = createTestRoom(now);
  rooms.push(created);
  return created;
}

function register(created: TestRoom): { agentId: string; keyId: string; fingerprint: string } {
  const owner = seedUser(created.ctx, "owner", "owner");
  const keys = pair();
  const { agent, key } = registerAgentWithKey(created.ctx, {
    displayName: "dsh",
    runtime: "dsh",
    publicKey: keys.pem,
    actorUserId: owner,
  });
  return { agentId: agent.id, keyId: key.id, fingerprint: key.fingerprint };
}

describe("public challenge limits and cleanup", () => {
  it("caps open challenges per key and reports 429", async () => {
    const created = room();
    const app = await buildApp({
      config: loadConfig({ LOG_LEVEL: "silent" }),
      database: created.handle,
    });
    try {
      const { fingerprint } = register(created);
      for (let index = 0; index < MAX_ACTIVE_CHALLENGES_PER_KEY; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/agent/challenge",
          payload: { fingerprint },
        });
        expect(response.statusCode).toBe(200);
      }
      const limited = await app.inject({
        method: "POST",
        url: "/api/v1/agent/challenge",
        payload: { fingerprint },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("rate_limited");
    } finally {
      await app.close();
    }
  });

  it("removes only used or expired challenges", () => {
    let clock = Date.now();
    const created = room(() => clock);
    const { fingerprint } = register(created);

    const expired = createAgentChallenge(created.ctx, { fingerprint, ttlMs: 10_000 });
    const consumed = createAgentChallenge(created.ctx, { fingerprint, ttlMs: 10_000 });
    created.ctx.db
      .update(agentChallenges)
      .set({ usedAt: clock })
      .where(eq(agentChallenges.id, consumed.challengeId))
      .run();

    clock += 120_000;
    const valid = createAgentChallenge(created.ctx, { fingerprint, ttlMs: 60_000 });

    const removed = cleanupExpiredChallenges(created.ctx, clock);
    expect(removed).toBe(2);
    const remaining = created.ctx.db.select().from(agentChallenges).all();
    expect(remaining.map((row) => row.id)).toEqual([valid.challengeId]);
    expect(remaining[0]!.id).not.toBe(expired.challengeId);
  });

  it("removes used or expired socket tickets and keeps a fresh one", () => {
    const clock = Date.now();
    const created = room(() => clock);
    const { agentId, keyId } = register(created);

    created.ctx.db
      .insert(agentSessions)
      .values({
        id: "ses_test",
        agentId,
        keyId,
        tokenHash: "hash_test",
        createdAt: clock,
        expiresAt: clock + 3_600_000,
        lastSeenAt: clock,
      })
      .run();
    created.ctx.db
      .insert(agentSocketTickets)
      .values([
        {
          id: "tkt_fresh",
          sessionId: "ses_test",
          ticketHash: "fresh",
          expiresAt: clock + 10_000,
          createdAt: clock,
        },
        {
          id: "tkt_expired",
          sessionId: "ses_test",
          ticketHash: "expired",
          expiresAt: clock - 1,
          createdAt: clock - 60_000,
        },
        {
          id: "tkt_used",
          sessionId: "ses_test",
          ticketHash: "used",
          expiresAt: clock + 10_000,
          usedAt: clock,
          createdAt: clock,
        },
      ])
      .run();

    const removed = cleanupExpiredSocketTickets(created.ctx, clock);
    expect(removed).toBe(2);
    expect(
      created.ctx.db
        .select()
        .from(agentSocketTickets)
        .all()
        .map((row) => row.id),
    ).toEqual(["tkt_fresh"]);
  });
});
