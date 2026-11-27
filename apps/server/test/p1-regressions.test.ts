import { describe, expect, it } from "vitest";
import { addMember } from "../src/modules/groups.js";
import { deleteMessage, listMessages, postMessage } from "../src/modules/messages.js";
import { isRealtimeOriginAllowed } from "../src/modules/realtime.js";
import { setUserRole } from "../src/modules/users.js";
import { createTestRoom, seedGroup, seedUser } from "./helpers.js";

describe("P1 message history paging", () => {
  it("returns the newest page by default and pages backwards without gaps", () => {
    const room = createTestRoom();
    const owner = seedUser(room.ctx, "owner", "owner");
    const groupId = seedGroup(room.ctx, owner);
    for (let index = 1; index <= 60; index += 1) {
      postMessage(room.ctx, {
        groupId,
        actor: { type: "user", id: owner },
        content: `message-${index}`,
      });
    }

    const newest = listMessages(room.ctx, {
      groupId,
      viewer: { type: "user", id: owner },
      limit: 50,
    });
    expect(newest.items).toHaveLength(50);
    expect(newest.items[0]?.content).toBe("message-11");
    expect(newest.items.at(-1)?.content).toBe("message-60");
    expect(newest.nextCursor).toBe(11);

    const older = listMessages(room.ctx, {
      groupId,
      viewer: { type: "user", id: owner },
      limit: 50,
      before: newest.nextCursor!,
    });
    expect(older.items.map((message) => message.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => `message-${index + 1}`),
    );
    expect(older.nextCursor).toBeNull();

    const overlapping = listMessages(room.ctx, {
      groupId,
      viewer: { type: "user", id: owner },
      limit: 50,
      before: 21,
    });
    expect(overlapping.items.at(-1)?.content).toBe("message-20");
  });
});

describe("P1 readonly message deletion", () => {
  it("rejects a readonly author and allows a writable manager", () => {
    const room = createTestRoom();
    const owner = seedUser(room.ctx, "owner", "owner");
    const readonly = seedUser(room.ctx, "readonly", "member");
    const groupId = seedGroup(room.ctx, owner);
    addMember(room.ctx, {
      groupId,
      actorUserId: owner,
      memberType: "user",
      memberId: readonly,
    });

    const message = postMessage(room.ctx, {
      groupId,
      actor: { type: "user", id: readonly },
      content: "readonly message",
    });
    setUserRole(room.ctx, { userId: readonly, role: "readonly", actorUserId: owner });
    expect(() =>
      deleteMessage(room.ctx, {
        messageId: message.id,
        actor: { type: "user", id: readonly },
      }),
    ).toThrow(/readonly|write permission/i);

    expect(() =>
      deleteMessage(room.ctx, {
        messageId: message.id,
        actor: { type: "user", id: owner },
      }),
    ).not.toThrow();
  });
});

describe("P1 realtime origin policy", () => {
  it("allows same-host in production and rejects cross-origin", () => {
    expect(isRealtimeOriginAllowed("https://chat.example.com", [], "chat.example.com")).toBe(true);
    expect(isRealtimeOriginAllowed("https://evil.example.com", [], "chat.example.com")).toBe(false);
    expect(isRealtimeOriginAllowed("https://chat.example.com.evil", [], "chat.example.com")).toBe(
      false,
    );
    expect(
      isRealtimeOriginAllowed(
        "https://chat.example.com/path",
        ["https://chat.example.com/base"],
        "chat.example.com",
      ),
    ).toBe(true);
    expect(
      isRealtimeOriginAllowed(
        "https://other.example.com",
        ["https://chat.example.com/base"],
        "chat.example.com",
      ),
    ).toBe(false);
  });
});
