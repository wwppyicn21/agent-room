import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import { agentCommands, type AgentCommandRow } from "@room/database";
import { newId } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { NotFoundError } from "./errors.js";

export const TASK_CANCEL_COMMAND = "task.cancel" as const;

/**
 * Commands are addressed to one Agent and are independent of the event/delivery
 * stream: a removed Agent must still learn that its execution was cancelled, so
 * the instruction survives reconnects until it is acknowledged.
 */
export function createTaskCancelCommand(
  db: RoomDb,
  input: {
    agentId: string;
    taskId: string;
    runId: string | null;
    reason: string | null;
    now: number;
  },
): AgentCommandRow {
  db.insert(agentCommands)
    .values({
      id: newId("cmd"),
      agentId: input.agentId,
      commandType: TASK_CANCEL_COMMAND,
      taskId: input.taskId,
      runId: input.runId,
      reason: input.reason,
      status: "pending",
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .run();
  const row = db
    .select()
    .from(agentCommands)
    .where(
      and(
        eq(agentCommands.agentId, input.agentId),
        eq(agentCommands.commandType, TASK_CANCEL_COMMAND),
        eq(agentCommands.taskId, input.taskId),
      ),
    )
    .get();
  if (!row) throw new Error(`task.cancel command for ${input.taskId} was not persisted`);
  return row;
}

/** Unacknowledged commands, oldest first. `includeDelivered` is used on connect. */
export function listAgentCommands(
  ctx: RoomContext,
  input: {
    agentId: string;
    includeDelivered?: boolean;
    /** Re-send delivered commands older than this timestamp (lease expiry). */
    staleDeliveredBefore?: number;
    limit?: number;
  },
): AgentCommandRow[] {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  // With a lease threshold only pending and *stale* delivered rows are listed;
  // otherwise includeDelivered controls whether fresh delivered rows are listed.
  const statuses =
    input.staleDeliveredBefore !== undefined
      ? (["pending"] as const)
      : input.includeDelivered
        ? (["pending", "delivered"] as const)
        : (["pending"] as const);
  const statusCondition = inArray(agentCommands.status, statuses);
  const staleCondition =
    input.staleDeliveredBefore === undefined
      ? undefined
      : and(
          eq(agentCommands.status, "delivered"),
          lte(agentCommands.deliveredAt, input.staleDeliveredBefore),
        );
  return ctx.db
    .select()
    .from(agentCommands)
    .where(
      and(
        eq(agentCommands.agentId, input.agentId),
        staleCondition === undefined ? statusCondition : or(statusCondition, staleCondition),
      ),
    )
    .orderBy(asc(agentCommands.createdAt), asc(agentCommands.id))
    .limit(limit)
    .all();
}

export function countUnackedCommands(ctx: RoomContext, agentId: string): number {
  return ctx.db
    .select({ id: agentCommands.id })
    .from(agentCommands)
    .where(
      and(
        eq(agentCommands.agentId, agentId),
        inArray(agentCommands.status, ["pending", "delivered"]),
      ),
    )
    .all().length;
}

/** Marks a pending command as delivered; redelivery of an unacked command is a no-op. */
export function markCommandDelivered(
  ctx: RoomContext,
  input: { commandId: string; agentId: string },
): void {
  ctx.db
    .update(agentCommands)
    .set({ status: "delivered", deliveredAt: ctx.now() })
    .where(
      and(
        eq(agentCommands.id, input.commandId),
        eq(agentCommands.agentId, input.agentId),
        eq(agentCommands.status, "pending"),
      ),
    )
    .run();
}

/**
 * Acknowledges a command. Unknown ids and commands owned by another Agent are
 * indistinguishable (404) so the endpoint cannot be used to probe other Agents.
 */
export function ackCommand(
  ctx: RoomContext,
  input: { commandId: string; agentId: string },
): AgentCommandRow {
  const row = ctx.db
    .select()
    .from(agentCommands)
    .where(eq(agentCommands.id, input.commandId))
    .get();
  if (!row || row.agentId !== input.agentId) {
    throw new NotFoundError(`command ${input.commandId} not found`);
  }
  if (row.status === "acked") return row;
  const now = ctx.now();
  ctx.db
    .update(agentCommands)
    .set({ status: "acked", ackedAt: now })
    .where(
      and(
        eq(agentCommands.id, input.commandId),
        eq(agentCommands.agentId, input.agentId),
        inArray(agentCommands.status, ["pending", "delivered"]),
      ),
    )
    .run();
  return ctx.db.select().from(agentCommands).where(eq(agentCommands.id, input.commandId)).get()!;
}
