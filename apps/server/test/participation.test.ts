import { eq } from "drizzle-orm";
import {
  agentDeliveries,
  agentKeys,
  agentSessions,
  events,
  groups,
  messages,
  type MessageRow,
} from "@room/database";
import { newId } from "@room/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMember, updateGroupAISettings } from "../src/modules/groups.js";
import { ConflictError, ForbiddenError, RateLimitError } from "../src/modules/errors.js";
import { postMessage } from "../src/modules/messages.js";
import { decideParticipation } from "../src/modules/participation.js";
import { createTestRoom, seedAgent, seedGroup, seedUser, type TestRoom } from "./helpers.js";

const settings = (overrides: Record<string, unknown> = {}) => ({
  participationMode: "all" as const,
  allowAgentMessages: true,
  maxHops: 4,
  maxRepliesPerRoot: 20,
  maxAgentMessagesPerMinute: 10,
  ...overrides,
});

describe("AI participation engine", () => {
  let room: TestRoom;
  let owner: string;

  beforeEach(() => {
    room = createTestRoom();
    owner = seedUser(room.ctx, "owner", "owner");
  });

  afterEach(() => room.close());

  /** Registers an agent plus a live session, i.e. it counts as online. */
  function agentOnline(displayName: string): string {
    const agentId = seedAgent(room.ctx, owner, displayName);
    const now = room.ctx.now();
    const keyId = newId("key");
    room.ctx.db
      .insert(agentKeys)
      .values({
        id: keyId,
        agentId,
        publicKey: `pem-${keyId}`,
        fingerprint: `fp-${keyId}`,
        createdAt: now,
      })
      .run();
    room.ctx.db
      .insert(agentSessions)
      .values({
        id: newId("ses"),
        agentId,
        keyId,
        tokenHash: `hash-${keyId}`,
        createdAt: now,
        expiresAt: now + 3_600_000,
        lastSeenAt: now,
      })
      .run();
    return agentId;
  }

  function setup(overrides: Record<string, unknown> = {}): {
    groupId: string;
    a: string;
    b: string;
  } {
    const groupId = seedGroup(room.ctx, owner);
    const a = agentOnline("AgentA");
    const b = agentOnline("AgentB");
    for (const id of [a, b]) {
      addMember(room.ctx, { groupId, actorUserId: owner, memberType: "agent", memberId: id });
    }
    updateGroupAISettings(room.ctx, {
      groupId,
      actorUserId: owner,
      settings: settings(overrides),
    });
    return { groupId, a, b };
  }

  function deliveredAgentIds(groupId: string): string[] {
    return room.ctx.db
      .select({ agentId: agentDeliveries.agentId })
      .from(agentDeliveries)
      .innerJoin(events, eq(agentDeliveries.eventId, events.id))
      .where(eq(events.groupId, groupId))
      .all()
      .map((row) => row.agentId)
      .sort();
  }

  it("delivers a user message to every online agent exactly once", () => {
    const { groupId, a, b } = setup();
    postMessage(room.ctx, { groupId, actor: { type: "user", id: owner }, content: "hello" });
    expect(deliveredAgentIds(groupId)).toEqual([a, b].sort());
  });

  it("honours mention mode and ignores unmentioned agents", () => {
    const { groupId, b } = setup({ participationMode: "mention" });
    postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "please look @agentB",
    });
    expect(deliveredAgentIds(groupId)).toEqual([b]);
  });

  it("ignores unmentioned agents in mention mode", () => {
    const { groupId } = setup({ participationMode: "mention" });
    postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "no mention here",
    });
    expect(deliveredAgentIds(groupId)).toEqual([]);
  });

  it("stays silent when participation is disabled", () => {
    const { groupId } = setup({ participationMode: "disabled" });
    postMessage(room.ctx, { groupId, actor: { type: "user", id: owner }, content: "hello" });
    expect(deliveredAgentIds(groupId)).toEqual([]);
  });

  it("does not deliver to agents whose session lease has ended", () => {
    const { groupId, a, b } = setup();
    room.ctx.db
      .update(agentSessions)
      .set({ closedAt: room.ctx.now() })
      .where(eq(agentSessions.agentId, b))
      .run();
    postMessage(room.ctx, { groupId, actor: { type: "user", id: owner }, content: "hello" });
    expect(deliveredAgentIds(groupId)).toEqual([a]);
  });

  it("refuses agent messages when the group disallows them", () => {
    const { groupId, a } = setup({ allowAgentMessages: false });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "hello",
    });
    expect(() =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: a },
        content: "should not appear",
        rootMessageId: source.id,
        replyToMessageId: source.id,
      }),
    ).toThrow(ForbiddenError);
    expect(room.ctx.db.select().from(messages).all()).toHaveLength(1);
  });

  it("chains agent replies with an incremented hop and never notifies the sender", () => {
    const { groupId, a, b } = setup();
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "hello",
    });
    const reply = postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "AgentA here",
      rootMessageId: source.id,
      replyToMessageId: source.id,
    });
    expect(reply.hop).toBe(1);
    expect(reply.rootMessageId).toBe(source.id);
    const replyEvent = room.ctx.db
      .select()
      .from(events)
      .where(eq(events.groupId, groupId))
      .all()
      .find((event) => event.payload.includes(reply.id));
    expect(replyEvent).toBeDefined();
    const forReply = room.ctx.db
      .select({ agentId: agentDeliveries.agentId })
      .from(agentDeliveries)
      .where(eq(agentDeliveries.eventId, replyEvent!.id))
      .all()
      .map((row) => row.agentId);
    expect(forReply).toEqual([b]);
    expect(forReply).not.toContain(a);
  });

  it("stops the chain once the hop limit is reached", () => {
    const { groupId, a, b } = setup({ maxHops: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "hello",
    });
    const first = postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "first",
      rootMessageId: source.id,
      replyToMessageId: source.id,
    });
    expect(() =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: b },
        content: "second",
        rootMessageId: source.id,
        replyToMessageId: first.id,
      }),
    ).toThrow(ConflictError);
    expect(room.ctx.db.select().from(messages).all()).toHaveLength(2);
  });

  it("stops the chain once the per-root reply budget is spent", () => {
    const { groupId, a, b } = setup({ maxRepliesPerRoot: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "hello",
    });
    postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "first",
      rootMessageId: source.id,
      replyToMessageId: source.id,
    });
    expect(() =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: b },
        content: "second",
        rootMessageId: source.id,
        replyToMessageId: source.id,
      }),
    ).toThrow(ConflictError);
    expect(room.ctx.db.select().from(messages).all()).toHaveLength(2);
  });

  it("rate limits an agent across groups", () => {
    const { groupId, a } = setup({ maxAgentMessagesPerMinute: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "hello",
    });
    postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "first",
      rootMessageId: source.id,
      replyToMessageId: source.id,
    });
    expect(() =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: a },
        content: "again",
        rootMessageId: source.id,
        replyToMessageId: source.id,
      }),
    ).toThrow(RateLimitError);
  });

  it("never treats system messages as chat input", () => {
    const { groupId } = setup();
    const group = room.ctx.db.select().from(groups).where(eq(groups.id, groupId)).get()!;
    const synthetic = {
      id: "msg_system",
      groupId,
      threadId: null,
      senderType: "system",
      senderId: "system",
      content: "task finished",
      rootMessageId: null,
      replyToMessageId: null,
      hop: 0,
      clientMessageId: null,
      seq: 1,
      createdAt: room.ctx.now(),
      deletedAt: null,
    } as MessageRow;
    const decision = decideParticipation(room.ctx, room.ctx.db, {
      group,
      message: synthetic,
      presenceTtlMs: 60_000,
    });
    expect(decision.reason).toBe("system_sender");
    expect(decision.agentIds).toEqual([]);
  });

  it("keeps groups isolated: a message in A never reaches a member of B", () => {
    const { groupId, a, b } = setup();
    const otherGroup = seedGroup(room.ctx, owner, "other");
    const outsider = agentOnline("AgentC");
    addMember(room.ctx, {
      groupId: otherGroup,
      actorUserId: owner,
      memberType: "agent",
      memberId: outsider,
    });
    postMessage(room.ctx, { groupId, actor: { type: "user", id: owner }, content: "hello" });
    expect(deliveredAgentIds(groupId)).toEqual([a, b].sort());
    expect(deliveredAgentIds(otherGroup)).toEqual([]);
  });
});
