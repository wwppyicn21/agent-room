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

  function stopEvents(): Array<Record<string, unknown>> {
    return room.ctx.db
      .select()
      .from(events)
      .all()
      .filter((event) => event.type === "participation.stopped")
      .map((event) => JSON.parse(event.payload) as Record<string, unknown>);
  }

  function messagesForGroup(groupId: string): MessageRow[] {
    return room.ctx.db.select().from(messages).where(eq(messages.groupId, groupId)).all();
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

  it("records a hop-limit diagnostic when a deeper reply is rejected", () => {
    const { groupId, a, b } = setup({ maxHops: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
    });
    const first = postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "hop one",
      rootMessageId: source.id,
      replyToMessageId: source.id,
    });
    expect(() =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: b },
        content: "too deep",
        rootMessageId: source.id,
        replyToMessageId: first.id,
      }),
    ).toThrow(ConflictError);

    const stops = stopEvents().filter((event) => event.senderId === b);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      reason: "hop_limit",
      rootMessageId: source.id,
      senderType: "agent",
      senderId: b,
    });
    expect(stops[0]).not.toHaveProperty("content");
    expect(
      room.ctx.db
        .select()
        .from(messages)
        .all()
        .filter((message) => message.content === "too deep"),
    ).toHaveLength(0);
  });

  it("records a reply-budget diagnostic when the chain stops", () => {
    const { groupId, a } = setup({ maxRepliesPerRoot: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
    });
    postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "only reply",
      rootMessageId: source.id,
      replyToMessageId: source.id,
    });
    const stops = stopEvents();
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ reason: "reply_budget", rootMessageId: source.id });
    expect(stops[0]).not.toHaveProperty("content");
  });

  it("records a rate-limit diagnostic for a rejected send and writes no message", () => {
    const { groupId, a } = setup({ maxAgentMessagesPerMinute: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
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
        content: "rejected",
        rootMessageId: source.id,
        replyToMessageId: source.id,
        clientMessageId: "rate-stop",
      }),
    ).toThrow(RateLimitError);

    const stops = stopEvents();
    expect(stops.at(-1)).toMatchObject({ reason: "rate_limit", senderId: a });
    expect(stops.at(-1)).not.toHaveProperty("content");
    expect(messagesForGroup(groupId)).toHaveLength(2);
    expect(
      room.ctx.db
        .select()
        .from(messages)
        .all()
        .filter((message) => message.clientMessageId === "rate-stop"),
    ).toHaveLength(0);
  });

  it("keeps exactly one message, event and delivery when a lost confirmation is retried", () => {
    const { groupId, a, b } = setup();
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
    });
    const send = () =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: a },
        content: "reply committed once",
        rootMessageId: source.id,
        replyToMessageId: source.id,
        clientMessageId: "lost-confirmation",
      });
    const first = send();
    const retried = send();
    expect(retried.id).toBe(first.id);
    expect(
      room.ctx.db
        .select()
        .from(messages)
        .all()
        .filter((message) => message.clientMessageId === "lost-confirmation"),
    ).toHaveLength(1);
    const createdEvents = room.ctx.db
      .select()
      .from(events)
      .all()
      .filter((event) => event.type === "message.created")
      .filter((event) => {
        const payload = JSON.parse(event.payload) as { messageId?: string };
        return payload.messageId === first.id;
      });
    expect(createdEvents).toHaveLength(1);
    const deliveriesToB = room.ctx.db
      .select()
      .from(agentDeliveries)
      .all()
      .filter((delivery) => delivery.agentId === b);
    expect(deliveriesToB).toHaveLength(2);
  });

  it("does not treat an email-like string as a mention", () => {
    const { groupId } = setup({ participationMode: "mention" });
    postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "contact user@agentA for details",
    });
    expect(deliveredAgentIds(groupId)).toEqual([]);
  });

  it("returns the original agent message when a retry arrives after the reply budget is spent", () => {
    const { groupId, a } = setup({ maxRepliesPerRoot: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
    });
    const reply = (clientMessageId: string) =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: a },
        content: "first reply",
        rootMessageId: source.id,
        replyToMessageId: source.id,
        clientMessageId,
      });
    const first = reply("retry-after-budget");
    const retry = reply("retry-after-budget");
    expect(retry.id).toBe(first.id);
    expect(messagesForGroup(groupId)).toHaveLength(2);
  });

  it("returns the original message when a retry arrives after the rate limit is reached", () => {
    const { groupId, a } = setup({ maxAgentMessagesPerMinute: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
    });
    const send = (clientMessageId: string) =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: a },
        content: "hello",
        rootMessageId: source.id,
        replyToMessageId: source.id,
        clientMessageId,
      });
    const first = send("retry-after-rate-limit");
    const retry = send("retry-after-rate-limit");
    expect(retry.id).toBe(first.id);
    expect(messagesForGroup(groupId)).toHaveLength(2);
    expect(() => send("new-message")).toThrow(RateLimitError);
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
  it("derives root and hop on the server and ignores client-supplied values", () => {
    const { groupId, a, b } = setup();
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
      rootMessageId: "msg_forged_root",
    });
    expect(source.rootMessageId).toBe(source.id);
    expect(source.hop).toBe(0);

    const first = postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "agent one",
      replyToMessageId: source.id,
      rootMessageId: "msg_forged_root",
    });
    expect(first.rootMessageId).toBe(source.id);
    expect(first.hop).toBe(1);

    const interjection = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "user interjects",
      replyToMessageId: first.id,
      rootMessageId: "msg_forged_root",
    });
    expect(interjection.rootMessageId).toBe(source.id);
    expect(interjection.hop).toBe(1);

    const second = postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: b },
      content: "agent two",
      replyToMessageId: interjection.id,
    });
    expect(second.rootMessageId).toBe(source.id);
    expect(second.hop).toBe(2);
  });

  it("keeps the root reply budget after a user interjects", () => {
    const { groupId, a, b } = setup({ maxRepliesPerRoot: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
    });
    const first = postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "only reply",
      replyToMessageId: source.id,
    });
    postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "user interjects",
      replyToMessageId: first.id,
    });
    expect(() =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: b },
        content: "over budget",
        replyToMessageId: first.id,
      }),
    ).toThrow(ConflictError);
    expect(messagesForGroup(groupId)).toHaveLength(3);
    expect(
      stopEvents()
        .filter((event) => event.senderId === b)
        .map((event) => event.reason),
    ).toEqual(["reply_budget"]);
  });

  it("stops fan-out when the hop limit is reached", () => {
    const { groupId, a, b } = setup({ maxHops: 2 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
    });
    const first = postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "hop one",
      replyToMessageId: source.id,
    });
    const before = room.ctx.db.select().from(agentDeliveries).all().length;
    const last = postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: b },
      content: "hop two",
      replyToMessageId: first.id,
    });
    expect(last.hop).toBe(2);
    expect(room.ctx.db.select().from(agentDeliveries).all().length).toBe(before);
    expect(
      stopEvents()
        .filter((event) => event.senderId === b)
        .map((event) => event.reason),
    ).toEqual(["hop_limit"]);
    expect(() =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: a },
        content: "hop three",
        replyToMessageId: last.id,
      }),
    ).toThrow(ConflictError);

    const interjection = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "does this restart?",
      replyToMessageId: last.id,
    });
    expect(interjection.hop).toBe(2);
    expect(room.ctx.db.select().from(agentDeliveries).all().length).toBe(before);
  });

  it("scopes the agent rate limit to each group", () => {
    const a = agentOnline("AgentA");
    const g1 = seedGroup(room.ctx, owner, "g1");
    const g2 = seedGroup(room.ctx, owner, "g2");
    for (const groupId of [g1, g2]) {
      addMember(room.ctx, {
        groupId,
        actorUserId: owner,
        memberType: "agent",
        memberId: a,
        memberRole: "member",
      });
      updateGroupAISettings(room.ctx, {
        groupId,
        actorUserId: owner,
        settings: settings({ maxAgentMessagesPerMinute: 1 }),
      });
    }
    const s1 = postMessage(room.ctx, {
      groupId: g1,
      actor: { type: "user", id: owner },
      content: "g1",
    });
    postMessage(room.ctx, {
      groupId: g1,
      actor: { type: "agent", id: a },
      content: "one in g1",
      replyToMessageId: s1.id,
      clientMessageId: "g1-one",
    });
    expect(() =>
      postMessage(room.ctx, {
        groupId: g1,
        actor: { type: "agent", id: a },
        content: "two in g1",
        replyToMessageId: s1.id,
        clientMessageId: "g1-two",
      }),
    ).toThrow(RateLimitError);

    const s2 = postMessage(room.ctx, {
      groupId: g2,
      actor: { type: "user", id: owner },
      content: "g2",
    });
    expect(
      postMessage(room.ctx, {
        groupId: g2,
        actor: { type: "agent", id: a },
        content: "first in g2",
        replyToMessageId: s2.id,
        clientMessageId: "g2-one",
      }).id,
    ).toBeTruthy();
  });

  it("does not count user or system messages toward the agent rate limit", () => {
    const a = agentOnline("AgentA");
    const groupId = seedGroup(room.ctx, owner, "rate");
    addMember(room.ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: a,
      memberRole: "member",
    });
    updateGroupAISettings(room.ctx, {
      groupId,
      actorUserId: owner,
      settings: settings({ maxAgentMessagesPerMinute: 1 }),
    });
    for (let i = 0; i < 3; i += 1) {
      postMessage(room.ctx, { groupId, actor: { type: "user", id: owner }, content: `user ${i}` });
    }
    const rows = messagesForGroup(groupId);
    room.ctx.db
      .insert(messages)
      .values({
        id: newId("msg"),
        groupId,
        senderType: "system",
        senderId: "system",
        content: "task progress",
        hop: 0,
        seq: Math.max(...rows.map((row) => row.seq)) + 1,
        createdAt: room.ctx.now(),
      })
      .run();
    const source = rows.find((row) => row.senderType === "user")!;
    expect(
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: a },
        content: "allowed",
        replyToMessageId: source.id,
        clientMessageId: "counts",
      }).id,
    ).toBeTruthy();
  });

  it("resets the group rate window after one minute", () => {
    let now = 1_000_000;
    const clockRoom = createTestRoom(() => now);
    try {
      const clockOwner = seedUser(clockRoom.ctx, "owner", "owner");
      const clockAgent = seedAgent(clockRoom.ctx, clockOwner, "AgentA");
      const groupId = seedGroup(clockRoom.ctx, clockOwner);
      addMember(clockRoom.ctx, {
        groupId,
        actorUserId: clockOwner,
        memberType: "agent",
        memberId: clockAgent,
        memberRole: "member",
      });
      updateGroupAISettings(clockRoom.ctx, {
        groupId,
        actorUserId: clockOwner,
        settings: settings({ maxAgentMessagesPerMinute: 1 }),
      });
      const source = postMessage(clockRoom.ctx, {
        groupId,
        actor: { type: "user", id: clockOwner },
        content: "root",
      });
      const reply = (suffix: string) =>
        postMessage(clockRoom.ctx, {
          groupId,
          actor: { type: "agent", id: clockAgent },
          content: "reply",
          replyToMessageId: source.id,
          clientMessageId: suffix,
        });
      reply("first");
      expect(() => reply("second")).toThrow(RateLimitError);
      now += 60_001;
      expect(reply("third").id).toBeTruthy();
    } finally {
      clockRoom.close();
    }
  });

  it("tracks the rate limit per agent", () => {
    const { groupId, a, b } = setup({ maxAgentMessagesPerMinute: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
    });
    postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "a first",
      replyToMessageId: source.id,
      clientMessageId: "a-1",
    });
    expect(() =>
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: a },
        content: "a second",
        replyToMessageId: source.id,
        clientMessageId: "a-2",
      }),
    ).toThrow(RateLimitError);
    expect(
      postMessage(room.ctx, {
        groupId,
        actor: { type: "agent", id: b },
        content: "b first",
        replyToMessageId: source.id,
        clientMessageId: "b-1",
      }).id,
    ).toBeTruthy();
  });

  it("stops fan-out for a user interjection once the reply budget is spent", () => {
    const { groupId, a } = setup({ maxRepliesPerRoot: 1 });
    const source = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "root",
    });
    expect(deliveredAgentIds(groupId)).toHaveLength(2);
    postMessage(room.ctx, {
      groupId,
      actor: { type: "agent", id: a },
      content: "only reply",
      rootMessageId: source.id,
      replyToMessageId: source.id,
    });
    postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "any update?",
      replyToMessageId: source.id,
    });
    expect(deliveredAgentIds(groupId)).toHaveLength(2);
    const stop = stopEvents().at(-1);
    expect(stop).toMatchObject({ reason: "reply_budget", rootMessageId: source.id });
  });
});
