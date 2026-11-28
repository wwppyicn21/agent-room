import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError } from "../src/modules/errors.js";
import { addMember, createGroup, removeMember, updateMemberRole } from "../src/modules/groups.js";
import { createTestRoom, seedUser, type TestRoom } from "./helpers.js";

const rooms: TestRoom[] = [];

function room(): TestRoom {
  const created = createTestRoom();
  rooms.push(created);
  return created;
}

afterEach(() => {
  for (const created of rooms.splice(0)) created.close();
});

function setup() {
  const { ctx } = room();
  const owner = seedUser(ctx, "owner", "owner");
  const admin = seedUser(ctx, "admin", "member");
  const groupId = createGroup(ctx, { name: "group", createdByUserId: owner }).id;
  addMember(ctx, {
    groupId,
    actorUserId: owner,
    memberType: "user",
    memberId: admin,
    memberRole: "admin",
  });
  const owner2 = seedUser(ctx, "owner2", "member");
  addMember(ctx, {
    groupId,
    actorUserId: owner,
    memberType: "user",
    memberId: owner2,
    memberRole: "owner",
  });
  return { ctx, owner, admin, owner2, groupId };
}

describe("group owner authority", () => {
  it("forbids a group admin from granting owner", () => {
    const { ctx, admin, groupId } = setup();
    const newcomer = seedUser(ctx, "newcomer", "member");

    expect(() =>
      addMember(ctx, {
        groupId,
        actorUserId: admin,
        memberType: "user",
        memberId: newcomer,
        memberRole: "owner",
      }),
    ).toThrow(ForbiddenError);
  });

  it("forbids a group admin from removing another owner", () => {
    const { ctx, admin, owner2, groupId } = setup();

    expect(() =>
      removeMember(ctx, {
        groupId,
        actorUserId: admin,
        memberType: "user",
        memberId: owner2,
      }),
    ).toThrow(ForbiddenError);
  });

  it("lets a group owner grant owner and keeps admin/member management working", () => {
    const { ctx, owner, admin, groupId } = setup();
    const promoted = seedUser(ctx, "promoted", "member");
    const added = addMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "user",
      memberId: promoted,
      memberRole: "owner",
    });
    expect(added.memberRole).toBe("owner");

    const regular = seedUser(ctx, "regular", "member");
    expect(
      addMember(ctx, {
        groupId,
        actorUserId: admin,
        memberType: "user",
        memberId: regular,
        memberRole: "member",
      }).memberRole,
    ).toBe("member");
    expect(() =>
      removeMember(ctx, {
        groupId,
        actorUserId: admin,
        memberType: "user",
        memberId: regular,
      }),
    ).not.toThrow();
  });

  it("lets a system admin manage owner roles in a group they did not join", () => {
    const { ctx, owner, groupId } = setup();
    const systemAdmin = seedUser(ctx, "system-admin", "admin");
    const target = seedUser(ctx, "target", "member");

    const added = addMember(ctx, {
      groupId,
      actorUserId: systemAdmin,
      memberType: "user",
      memberId: target,
      memberRole: "owner",
    });
    expect(added.memberRole).toBe("owner");

    expect(() =>
      removeMember(ctx, {
        groupId,
        actorUserId: systemAdmin,
        memberType: "user",
        memberId: owner,
      }),
    ).not.toThrow();
  });

  it("does not let a group admin demote an owner", () => {
    const { ctx, admin, owner2, groupId } = setup();

    expect(() =>
      updateMemberRole(ctx, {
        groupId,
        actorUserId: admin,
        memberType: "user",
        memberId: owner2,
        memberRole: "member",
      }),
    ).toThrow(ForbiddenError);
  });

  it("keeps the last owner from being removed or demoted", () => {
    const { ctx, owner, owner2, groupId } = setup();
    removeMember(ctx, {
      groupId,
      actorUserId: owner,
      memberType: "user",
      memberId: owner2,
    });

    expect(() =>
      removeMember(ctx, {
        groupId,
        actorUserId: owner,
        memberType: "user",
        memberId: owner,
      }),
    ).toThrow(ConflictError);
    expect(() =>
      updateMemberRole(ctx, {
        groupId,
        actorUserId: owner,
        memberType: "user",
        memberId: owner,
        memberRole: "member",
      }),
    ).toThrow(ConflictError);
  });
});
