import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
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
import { ConflictError, NotFoundError } from "./errors.js";
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

/**
 * Pending plus delivered-but-not-yet-acked rows. A delivered row whose agent
 * disconnected before acking stays recoverable instead of silently dropping.
 */
/** Server-managed delivery lease; a delivered-but-unacked event is retried after it. */
export const DELIVERY_LEASE_MS = 30_000;
/** Hard cap so a permanently stuck Agent cannot occupy the delivery window forever. */
export const MAX_DELIVERY_ATTEMPTS = 10;

export function listOutstandingDeliveries(
  ctx: RoomContext,
  input: {
    agentId: string;
    limit?: number;
    leaseMs?: number;
    now?: number;
    /** Re-send every delivered-but-unacked row (used on reconnect). */
    includeUnacked?: boolean;
  },
): AgentDeliveryRow[] {
  requireAgent(ctx.db, input.agentId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const now = input.now ?? ctx.now();
  const leaseCutoff = now - (input.leaseMs ?? DELIVERY_LEASE_MS);
  return ctx.db
    .select()
    .from(agentDeliveries)
    .where(
      and(
        eq(agentDeliveries.agentId, input.agentId),
        or(
          eq(agentDeliveries.status, "pending"),
          input.includeUnacked
            ? eq(agentDeliveries.status, "delivered")
            : and(
                eq(agentDeliveries.status, "delivered"),
                or(
                  isNull(agentDeliveries.deliveredAt),
                  lte(agentDeliveries.deliveredAt, leaseCutoff),
                ),
              ),
        ),
      ),
    )
    .orderBy(asc(agentDeliveries.createdAt), asc(agentDeliveries.id))
    .limit(limit)
    .all();
}

function getDeliveryForAgent(
  ctx: RoomContext,
  deliveryId: string,
  agentId: string,
): AgentDeliveryRow {
  requireAgent(ctx.db, agentId);
  const delivery = ctx.db
    .select()
    .from(agentDeliveries)
    .where(and(eq(agentDeliveries.id, deliveryId), eq(agentDeliveries.agentId, agentId)))
    .get();
  if (!delivery) throw new NotFoundError(`delivery ${deliveryId} not found`);
  return delivery;
}

/** pending -> delivered. Every attempt increments `attempts`. */
export function markDeliveryDelivered(
  ctx: RoomContext,
  input: { deliveryId: string; agentId: string; now?: number },
): AgentDeliveryRow {
  const delivery = getDeliveryForAgent(ctx, input.deliveryId, input.agentId);
  if (delivery.status !== "pending") {
    throw new ConflictError(
      `delivery ${delivery.id} is ${delivery.status}; only pending deliveries can be delivered`,
    );
  }
  const now = input.now ?? ctx.now();
  ctx.db
    .update(agentDeliveries)
    .set({
      status: "delivered",
      attempts: delivery.attempts + 1,
      deliveredAt: now,
      lastError: null,
    })
    .where(eq(agentDeliveries.id, delivery.id))
    .run();
  return { ...delivery, status: "delivered", attempts: delivery.attempts + 1, deliveredAt: now };
}

/** delivered -> acked. Acking an already acked delivery is idempotent. */
/** Re-send a delivered but still unacked event after its lease expired. */
export function redeliverDelivery(
  ctx: RoomContext,
  input: { deliveryId: string; agentId: string; now?: number },
): AgentDeliveryRow {
  const delivery = getDeliveryForAgent(ctx, input.deliveryId, input.agentId);
  if (delivery.status !== "delivered") {
    throw new ConflictError(
      `delivery ${delivery.id} is ${delivery.status}; only leased deliveries can be retried`,
    );
  }
  const now = input.now ?? ctx.now();
  ctx.db
    .update(agentDeliveries)
    .set({ attempts: delivery.attempts + 1, deliveredAt: now, lastError: null })
    .where(eq(agentDeliveries.id, delivery.id))
    .run();
  return { ...delivery, attempts: delivery.attempts + 1, deliveredAt: now, lastError: null };
}

export function ackDelivery(
  ctx: RoomContext,
  input: { deliveryId: string; agentId: string; now?: number },
): AgentDeliveryRow {
  const delivery = getDeliveryForAgent(ctx, input.deliveryId, input.agentId);
  if (delivery.status === "acked") return delivery;
  if (delivery.status !== "delivered") {
    throw new ConflictError(
      `delivery ${delivery.id} is ${delivery.status}; only delivered deliveries can be acked`,
    );
  }
  const now = input.now ?? ctx.now();
  ctx.db
    .update(agentDeliveries)
    .set({ status: "acked", ackedAt: now })
    .where(eq(agentDeliveries.id, delivery.id))
    .run();
  return { ...delivery, status: "acked", ackedAt: now };
}

/** pending|delivered -> failed. Failing an already failed delivery is idempotent. */
export function failDelivery(
  ctx: RoomContext,
  input: { deliveryId: string; agentId: string; error?: string | null; now?: number },
): AgentDeliveryRow {
  const delivery = getDeliveryForAgent(ctx, input.deliveryId, input.agentId);
  if (delivery.status === "failed") return delivery;
  if (delivery.status === "acked") {
    throw new ConflictError(`delivery ${delivery.id} is acked and cannot fail`);
  }
  ctx.db
    .update(agentDeliveries)
    .set({ status: "failed", lastError: input.error ?? "delivery failed" })
    .where(eq(agentDeliveries.id, delivery.id))
    .run();
  return { ...delivery, status: "failed", lastError: input.error ?? "delivery failed" };
}

/** delivered -> pending, for retrying a delivery whose ack never arrived. */
export function requeueDelivery(
  ctx: RoomContext,
  input: { deliveryId: string; agentId: string },
): AgentDeliveryRow {
  const delivery = getDeliveryForAgent(ctx, input.deliveryId, input.agentId);
  if (delivery.status === "pending") return delivery;
  if (delivery.status !== "delivered") {
    throw new ConflictError(
      `delivery ${delivery.id} is ${delivery.status}; only delivered deliveries can be requeued`,
    );
  }
  ctx.db
    .update(agentDeliveries)
    .set({ status: "pending", deliveredAt: null })
    .where(eq(agentDeliveries.id, delivery.id))
    .run();
  return { ...delivery, status: "pending", deliveredAt: null };
}
