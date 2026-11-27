import { max, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events } from "@room/database";
import { listMessages, postMessage } from "../src/modules/messages.js";
import { createTestRoom, seedGroup, seedUser, type TestRoom } from "./helpers.js";

let room: TestRoom;
let owner: string;
let groupA: string;
let groupB: string;

beforeEach(() => {
  room = createTestRoom();
  owner = seedUser(room.ctx, "Owner", "owner");
  groupA = seedGroup(room.ctx, owner, "A");
  groupB = seedGroup(room.ctx, owner, "B");
});

afterEach(() => {
  room.close();
});

function maxEventSeq(groupId: string): number {
  const row = room.ctx.db
    .select({ value: max(events.seq) })
    .from(events)
    .where(eq(events.groupId, groupId))
    .get();
  return row?.value ?? 0;
}

describe("message history event cursor", () => {
  it("returns the group event cursor, not the global cursor", () => {
    for (let index = 0; index < 3; index += 1) {
      postMessage(room.ctx, {
        groupId: groupA,
        actor: { type: "user", id: owner },
        content: `a-${index}`,
      });
    }
    for (let index = 0; index < 8; index += 1) {
      postMessage(room.ctx, {
        groupId: groupB,
        actor: { type: "user", id: owner },
        content: `b-${index}`,
      });
    }
    const history = listMessages(room.ctx, {
      groupId: groupA,
      viewer: { type: "user", id: owner },
    });
    expect(history.eventCursor).toBe(maxEventSeq(groupA));
    expect(history.eventCursor).toBeLessThan(maxEventSeq(groupB));
    expect(history.eventCursor).toBeGreaterThan(Math.max(...history.items.map((item) => item.seq)));

    postMessage(room.ctx, {
      groupId: groupA,
      actor: { type: "user", id: owner },
      content: "a-later",
    });
    const next = listMessages(room.ctx, {
      groupId: groupA,
      viewer: { type: "user", id: owner },
    });
    expect(next.eventCursor).toBeGreaterThan(history.eventCursor);
  });

  it("keeps the message page and cursor consistent for a cursor page", () => {
    for (let index = 0; index < 5; index += 1) {
      postMessage(room.ctx, {
        groupId: groupA,
        actor: { type: "user", id: owner },
        content: `a-${index}`,
      });
    }
    const page = listMessages(room.ctx, {
      groupId: groupA,
      viewer: { type: "user", id: owner },
      limit: 2,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items.at(-1)?.content).toBe("a-4");
    expect(page.nextCursor).toBe(page.items[0]?.seq);
    expect(page.eventCursor).toBe(maxEventSeq(groupA));
  });
});
