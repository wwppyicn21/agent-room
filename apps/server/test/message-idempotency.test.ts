import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { messages } from "@room/database";
import { createThread, postMessage } from "../src/modules/index.js";
import { addMember } from "../src/modules/groups.js";
import { ConflictError } from "../src/modules/errors.js";
import { createTestRoom, seedGroup, seedUser } from "./helpers.js";

function setup() {
  const room = createTestRoom();
  const ctx = room.ctx;
  const owner = seedUser(ctx, "owner", "owner");
  const member = seedUser(ctx, "member", "member");
  const groupId = seedGroup(ctx, owner, "idempotency");
  addMember(ctx, { groupId, actorUserId: owner, memberType: "user", memberId: member });
  const source = postMessage(ctx, {
    groupId,
    actor: { type: "user", id: owner },
    content: "start here",
  });
  return { room, ctx, owner, member, groupId, source };
}

describe("M5 Review Fix 3B — message idempotency payload matching", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("returns the original message for an identical retry", () => {
    const { room, ctx, owner, groupId } = setup();
    cleanup = room.close;
    const first = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "same request",
      clientMessageId: "cid-1",
    });
    const second = postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "same request",
      clientMessageId: "cid-1",
    });
    expect(second.id).toBe(first.id);
    expect(
      ctx.db
        .select()
        .from(messages)
        .where(and(eq(messages.groupId, groupId), eq(messages.clientMessageId, "cid-1")))
        .all(),
    ).toHaveLength(1);
    expect(
      ctx.db.select().from(messages).where(eq(messages.clientMessageId, "cid-1")).all(),
    ).toHaveLength(1);
  });

  it("rejects reusing a clientMessageId with different content", () => {
    const { room, ctx, owner, groupId } = setup();
    cleanup = room.close;
    postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "original",
      clientMessageId: "cid-2",
    });
    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: "different",
        clientMessageId: "cid-2",
      }),
    ).toThrow(ConflictError);
  });

  it("rejects reusing a clientMessageId across threads", () => {
    const { room, ctx, owner, groupId, source } = setup();
    cleanup = room.close;
    const thread = createThread(ctx, {
      groupId,
      sourceMessageId: source.id,
      title: "thread",
      createdByUserId: owner,
    });
    postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "in the group",
      clientMessageId: "cid-3",
    });
    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: "in the group",
        clientMessageId: "cid-3",
        threadId: thread.id,
      }),
    ).toThrow(ConflictError);
  });

  it("rejects reusing a clientMessageId from a different sender", () => {
    const { room, ctx, owner, member, groupId } = setup();
    cleanup = room.close;
    postMessage(ctx, {
      groupId,
      actor: { type: "user", id: owner },
      content: "from owner",
      clientMessageId: "cid-4",
    });
    expect(() =>
      postMessage(ctx, {
        groupId,
        actor: { type: "user", id: member },
        content: "from owner",
        clientMessageId: "cid-4",
      }),
    ).toThrow(ConflictError);
  });

  it("keeps a single message when the same request is submitted concurrently", async () => {
    const { room, ctx, owner, groupId } = setup();
    cleanup = room.close;
    const payload = {
      groupId,
      actor: { type: "user" as const, id: owner },
      content: "concurrent",
      clientMessageId: "cid-5",
    };
    const results = await Promise.all([postMessage(ctx, payload), postMessage(ctx, payload)]);
    expect(results[0].id).toBe(results[1].id);
    expect(
      ctx.db.select().from(messages).where(eq(messages.clientMessageId, "cid-5")).all(),
    ).toHaveLength(1);
  });
});
