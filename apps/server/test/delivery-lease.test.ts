import { eq } from "drizzle-orm";
import { agentDeliveries, agents, messages } from "@room/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMember } from "../src/modules/groups.js";
import {
  ackDelivery,
  DELIVERY_LEASE_MS,
  failDelivery,
  listOutstandingDeliveries,
  MAX_DELIVERY_ATTEMPTS,
  markDeliveryDelivered,
  redeliverDelivery,
  requeueDelivery,
} from "../src/modules/events.js";
import { ForbiddenError, NotFoundError } from "../src/modules/errors.js";
import { postMessage } from "../src/modules/messages.js";
import {
  createTestRoom,
  markAgentOnline,
  seedAgent,
  seedGroup,
  seedUser,
  type TestRoom,
} from "./helpers.js";

describe("delivery lease and retries", () => {
  let clock = 1_000_000;
  let room: TestRoom;
  let owner: string;
  let groupId: string;
  let agentId: string;

  beforeEach(() => {
    clock = 1_000_000;
    room = createTestRoom(() => clock);
    owner = seedUser(room.ctx, "owner", "owner");
    agentId = seedAgent(room.ctx, owner, "AgentA");
    groupId = seedGroup(room.ctx, owner);
    addMember(room.ctx, {
      groupId,
      actorUserId: owner,
      memberType: "agent",
      memberId: agentId,
      memberRole: "member",
    });
    markAgentOnline(room.ctx, agentId);
    postMessage(room.ctx, { groupId, actor: { type: "user", id: owner }, content: "hi" });
  });

  afterEach(() => room.close());

  function outstanding(agent = agentId): string[] {
    return listOutstandingDeliveries(room.ctx, { agentId: agent }).map((d) => d.id);
  }

  it("leases a delivered event and retries it with the same delivery id", () => {
    const [delivery] = listOutstandingDeliveries(room.ctx, { agentId });
    markDeliveryDelivered(room.ctx, { deliveryId: delivery.id, agentId });
    expect(outstanding()).toEqual([]);
    expect(listOutstandingDeliveries(room.ctx, { agentId, includeUnacked: true })).toHaveLength(1);

    clock += DELIVERY_LEASE_MS + 1;
    expect(outstanding()).toEqual([delivery.id]);
    const retried = redeliverDelivery(room.ctx, { deliveryId: delivery.id, agentId });
    expect(retried.id).toBe(delivery.id);
    expect(retried.attempts).toBe(2);
    expect(ctxMessages()).toHaveLength(1);

    const acked = ackDelivery(room.ctx, { deliveryId: delivery.id, agentId });
    expect(acked.status).toBe("acked");
    expect(outstanding()).toEqual([]);
    clock += DELIVERY_LEASE_MS + 1;
    expect(outstanding()).toEqual([]);
  });

  it("requeues an unacked delivery without creating another message", () => {
    const [delivery] = listOutstandingDeliveries(room.ctx, { agentId });
    markDeliveryDelivered(room.ctx, { deliveryId: delivery.id, agentId });
    expect(requeueDelivery(room.ctx, { deliveryId: delivery.id, agentId }).status).toBe("pending");
    expect(outstanding()).toEqual([delivery.id]);
    expect(ctxMessages()).toHaveLength(1);
  });

  it("quarantines a delivery after the retry budget is exhausted", () => {
    const [delivery] = listOutstandingDeliveries(room.ctx, { agentId });
    markDeliveryDelivered(room.ctx, { deliveryId: delivery.id, agentId });
    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
      clock += DELIVERY_LEASE_MS + 1;
      redeliverDelivery(room.ctx, { deliveryId: delivery.id, agentId });
    }
    const failed = failDelivery(room.ctx, {
      deliveryId: delivery.id,
      agentId,
      error: "max delivery attempts reached",
    });
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe("max delivery attempts reached");
    expect(outstanding()).toEqual([]);
    expect(ctxMessages()).toHaveLength(1);
  });

  it("does not let a stuck delivery block newer ones", () => {
    for (let i = 0; i < 3; i += 1) {
      postMessage(room.ctx, { groupId, actor: { type: "user", id: owner }, content: `m${i}` });
    }
    const all = listOutstandingDeliveries(room.ctx, { agentId, limit: 10 });
    expect(all.length).toBe(4);
    markDeliveryDelivered(room.ctx, { deliveryId: all[0].id, agentId });
    failDelivery(room.ctx, { deliveryId: all[0].id, agentId, error: "stuck" });
    expect(outstanding()).toHaveLength(3);
  });

  it("rejects acks from another agent or after a delivery failed", () => {
    const other = seedAgent(room.ctx, owner, "AgentB");
    markAgentOnline(room.ctx, other);
    const [delivery] = listOutstandingDeliveries(room.ctx, { agentId });
    markDeliveryDelivered(room.ctx, { deliveryId: delivery.id, agentId });
    expect(() => ackDelivery(room.ctx, { deliveryId: delivery.id, agentId: other })).toThrow(
      NotFoundError,
    );
    failDelivery(room.ctx, { deliveryId: delivery.id, agentId, error: "timeout" });
    expect(() => ackDelivery(room.ctx, { deliveryId: delivery.id, agentId })).toThrow();
  });

  it("stops delivering to a disabled agent", () => {
    room.ctx.db.update(agents).set({ status: "disabled" }).where(eq(agents.id, agentId)).run();
    expect(() => listOutstandingDeliveries(room.ctx, { agentId })).toThrow(ForbiddenError);
    expect(room.ctx.db.select().from(agentDeliveries).all().length).toBe(1);
  });

  function ctxMessages() {
    return room.ctx.db.select().from(messages).where(eq(messages.groupId, groupId)).all();
  }
});
