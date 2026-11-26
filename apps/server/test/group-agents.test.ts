import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listGroupAgents } from "../src/modules/agents.js";
import { ForbiddenError, ValidationError } from "../src/modules/errors.js";
import { addMember } from "../src/modules/groups.js";
import { postMessage } from "../src/modules/messages.js";
import { assignTask, createTaskFromMessage } from "../src/modules/tasks.js";
import { disableAgent } from "../src/modules/agents.js";
import { createTestRoom, seedAgent, seedGroup, seedUser, type TestRoom } from "./helpers.js";

let room: TestRoom;
let owner: string;
let member: string;
let groupA: string;
let groupB: string;
let agentA: string;
let agentB: string;

beforeEach(() => {
  room = createTestRoom();
  owner = seedUser(room.ctx, "Owner", "owner");
  member = seedUser(room.ctx, "Member", "member");
  groupA = seedGroup(room.ctx, owner, "A");
  groupB = seedGroup(room.ctx, owner, "B");
  agentA = seedAgent(room.ctx, owner, "Agent A");
  agentB = seedAgent(room.ctx, owner, "Agent B");
  addMember(room.ctx, {
    groupId: groupA,
    actorUserId: owner,
    memberType: "user",
    memberId: member,
  });
  addMember(room.ctx, {
    groupId: groupA,
    actorUserId: owner,
    memberType: "agent",
    memberId: agentA,
  });
  addMember(room.ctx, {
    groupId: groupB,
    actorUserId: owner,
    memberType: "agent",
    memberId: agentB,
  });
});

afterEach(() => {
  room.close();
});

describe("group-scoped agent listing", () => {
  it("lists only members of the requested group", () => {
    expect(listGroupAgents(room.ctx, { groupId: groupA, viewerUserId: member })).toEqual([
      { id: agentA, displayName: "Agent A", status: "offline" },
    ]);
    expect(listGroupAgents(room.ctx, { groupId: groupB, viewerUserId: owner })).toEqual([
      { id: agentB, displayName: "Agent B", status: "offline" },
    ]);
  });

  it("rejects non-members and hides disabled agents", () => {
    const outsider = seedUser(room.ctx, "Outsider");
    expect(() => listGroupAgents(room.ctx, { groupId: groupA, viewerUserId: outsider })).toThrow(
      ForbiddenError,
    );
    disableAgent(room.ctx, { agentId: agentA, actorUserId: owner });
    expect(listGroupAgents(room.ctx, { groupId: groupA, viewerUserId: member })).toEqual([]);
  });

  it("refuses cross-group assignment at the service boundary", () => {
    const source = postMessage(room.ctx, {
      groupId: groupA,
      actor: { type: "user", id: owner },
      content: "source",
    });
    expect(() =>
      createTaskFromMessage(room.ctx, {
        groupId: groupA,
        sourceMessageId: source.id,
        title: "cross-group",
        createdByUserId: owner,
        assignedAgentId: agentB,
      }),
    ).toThrow(ValidationError);

    const { task } = createTaskFromMessage(room.ctx, {
      groupId: groupA,
      sourceMessageId: source.id,
      title: "assign later",
      createdByUserId: owner,
    });
    expect(() =>
      assignTask(room.ctx, { taskId: task.id, agentId: agentB, actorUserId: owner }),
    ).toThrow(ValidationError);
  });
});
