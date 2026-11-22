import { and, asc, eq } from "drizzle-orm";
import {
  agentDeliveries,
  type AgentDeliveryRow,
  type EventRow,
  events,
  groupMembers,
} from "@room/database";
import { newId } from "@room/protocol";
import { type EventType, eventPayloadSchema } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { NotFoundError } from "./errors.js";
import { requireAgent } from "./permissions.js";
import type { Actor } from "./permissions.js";

export type SystemActor = { readonly type: "system"; readonly id: string };
export type EventActor = Actor | SystemActor;

export interface AppendEventInput {
  type: EventType;
  actor: EventActor;
  groupId?: string | null;
  threadId?: string | null;
  taskId?: string | null;
  payload?: Record<string, unknown>;
  createdAt: number;
  id?: string;
}

/**
 * Append an event inside the caller's transaction. The `events` row, the
 * business change and the delivery rows commit or roll back together (plan
 * §6.3, transactional outbox).
 */
export function appendEvent(db: RoomDb, input: AppendEventInput): EventRow {
  const payload = eventPayloadSchema.parse(input.payload ?? {});
  const id = input.id ?? newId("evt");
  const actorType = input.actor.type;
  const actorId = input.actor.id;
  db.insert(events)
    .values({
      id,
      type: input.type,
      groupId: input.groupId ?? null,
      threadId: input.threadId ?? null,
      taskId: input.taskId ?? null,
      actorType,
      actorId,
      payload: JSON.stringify(payload),
      createdAt: input.createdAt,
    })
    .run();
  return db.select().from(events).where(eq(events.id, id)).get()!;
}

export function enqueueDelivery(
  db: RoomDb,
  input: { agentId: string; eventId: string; createdAt: number },
): AgentDeliveryRow {
  const id = newId("evd");
  db.insert(agentDeliveries)
    .values({
      id,
      agentId: input.agentId,
      eventId: input.eventId,
      status: "pending",
      attempts: 0,
      createdAt: input.createdAt,
    })
    .onConflictDoNothing()
    .run();
  return db
    .select()
    .from(agentDeliveries)
    .where(
      and(eq(agentDeliveries.agentId, input.agentId), eq(agentDeliveries.eventId, input.eventId)),
    )
    .get()!;
}

/** Fan a committed event out to every agent member of the group, except the sender. */
export function enqueueGroupAgentDeliveries(
  db: RoomDb,
  input: { groupId: string; eventId: string; createdAt: number; excludeAgentId?: string | null },
): number {
  const members = db
    .select({ memberId: groupMembers.memberId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.memberType, "agent")))
    .all();
  let count = 0;
  for (const member of members) {
    if (input.excludeAgentId && member.memberId === input.excludeAgentId) continue;
    enqueueDelivery(db, {
      agentId: member.memberId,
      eventId: input.eventId,
      createdAt: input.createdAt,
    });
    count += 1;
  }
  return count;
}

export function listPendingDeliveries(
  ctx: RoomContext,
  input: { agentId: string; limit?: number },
): AgentDeliveryRow[] {
  requireAgent(ctx.db, input.agentId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return ctx.db
    .select()
    .from(agentDeliveries)
    .where(and(eq(agentDeliveries.agentId, input.agentId), eq(agentDeliveries.status, "pending")))
    .orderBy(asc(agentDeliveries.createdAt), asc(agentDeliveries.id))
    .limit(limit)
    .all();
}

export function markDeliveryDelivered(
  ctx: RoomContext,
  input: { deliveryId: string; agentId: string; now?: number },
): AgentDeliveryRow {
  requireAgent(ctx.db, input.agentId);
  const delivery = ctx.db
    .select()
    .from(agentDeliveries)
    .where(
      and(eq(agentDeliveries.id, input.deliveryId), eq(agentDeliveries.agentId, input.agentId)),
    )
    .get();
  if (!delivery) throw new NotFoundError(`delivery ${input.deliveryId} not found`);
  const now = input.now ?? ctx.now();
  ctx.db
    .update(agentDeliveries)
    .set({
      status: "delivered",
      attempts: delivery.attempts + 1,
      deliveredAt: now,
    })
    .where(eq(agentDeliveries.id, delivery.id))
    .run();
  return { ...delivery, status: "delivered", attempts: delivery.attempts + 1, deliveredAt: now };
}

export function ackDelivery(
  ctx: RoomContext,
  input: { deliveryId: string; agentId: string; now?: number },
): AgentDeliveryRow {
  requireAgent(ctx.db, input.agentId);
  const delivery = ctx.db
    .select()
    .from(agentDeliveries)
    .where(
      and(eq(agentDeliveries.id, input.deliveryId), eq(agentDeliveries.agentId, input.agentId)),
    )
    .get();
  if (!delivery) throw new NotFoundError(`delivery ${input.deliveryId} not found`);
  const now = input.now ?? ctx.now();
  ctx.db
    .update(agentDeliveries)
    .set({ status: "acked", ackedAt: now })
    .where(eq(agentDeliveries.id, delivery.id))
    .run();
  return { ...delivery, status: "acked", ackedAt: now };
}
