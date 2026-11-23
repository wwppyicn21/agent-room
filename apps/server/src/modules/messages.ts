import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { messages, type MessageRow, threads } from "@room/database";
import { AGENT_PRESENCE_TTL_MS, newId } from "@room/protocol";
import { messageContentSchema } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from "./errors.js";
import { appendEvent, enqueueDelivery } from "./events.js";
import {
  assertAgentRateLimit,
  countAgentRepliesForRoot,
  decideParticipation,
  rootMessageIdOf,
} from "./participation.js";
import {
  participationReasonOf,
  recordParticipationStop,
  withParticipationReason,
} from "./participation.js";
import {
  type Actor,
  requireActiveGroup,
  requireGroupMember,
  requireWritableActor,
} from "./permissions.js";

export interface PostMessageInput {
  groupId: string;
  actor: Actor;
  content: string;
  threadId?: string | null;
  rootMessageId?: string | null;
  replyToMessageId?: string | null;
  clientMessageId?: string | null;
  /** Presence lease used to pick online Agents (default 60s, plan §9.1). */
  presenceTtlMs?: number;
}

export function postMessage(ctx: RoomContext, input: PostMessageInput): MessageRow {
  try {
    return postMessageInTransaction(ctx, input);
  } catch (error) {
    recordRejectedAgentMessage(ctx, input, error);
    throw error;
  }
}

function recordRejectedAgentMessage(
  ctx: RoomContext,
  input: PostMessageInput,
  error: unknown,
): void {
  if (input.actor.type !== "agent") return;
  const reason = participationReasonOf(error);
  if (!reason) return;
  try {
    appendEvent(ctx.db, {
      type: "participation.stopped",
      actor: { type: "system", id: "participation-engine" },
      groupId: input.groupId,
      payload: {
        reason,
        rootMessageId: input.rootMessageId ?? input.replyToMessageId ?? null,
        senderType: "agent",
        senderId: input.actor.id,
        agentId: input.actor.id,
      },
      createdAt: ctx.now(),
    });
  } catch {
    // Diagnostics must never mask the original rejection.
  }
}

function postMessageInTransaction(ctx: RoomContext, input: PostMessageInput): MessageRow {
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    const group = requireActiveGroup(db, input.groupId);
    requireWritableActor(db, input.actor);
    requireGroupMember(db, input.groupId, input.actor);
    const content = messageContentSchema.parse(input.content);
    let hop = 0;
    let effectiveRoot: string | null = input.rootMessageId ?? null;

    if (input.threadId) {
      const thread = db.select().from(threads).where(eq(threads.id, input.threadId)).get();
      if (!thread) throw new NotFoundError(`thread ${input.threadId} not found`);
      if (thread.groupId !== input.groupId) {
        throw new ValidationError("thread belongs to a different group");
      }
      if (thread.status !== "open") {
        throw new ConflictError(`thread ${thread.id} is closed and cannot receive messages`);
      }
    }
    for (const [field, id] of [
      ["rootMessageId", input.rootMessageId],
      ["replyToMessageId", input.replyToMessageId],
    ] as const) {
      if (!id) continue;
      const parent = db.select().from(messages).where(eq(messages.id, id)).get();
      if (!parent) throw new NotFoundError(`${field} ${id} not found`);
      if (parent.groupId !== input.groupId) {
        throw new ValidationError(`${field} belongs to a different group`);
      }
    }

    const clientMessageId = input.clientMessageId?.trim() || null;
    if (clientMessageId) {
      const existing = db
        .select()
        .from(messages)
        .where(
          and(eq(messages.groupId, input.groupId), eq(messages.clientMessageId, clientMessageId)),
        )
        .get();
      if (existing) return existing;
    }

    if (input.actor.type === "agent") {
      if (!group.allowAgentMessages) {
        throw withParticipationReason(
          new ForbiddenError(`group ${input.groupId} does not allow agent messages`),
          "agent_messages_disallowed",
        );
      }
      const parentId = input.replyToMessageId ?? input.rootMessageId;
      if (!parentId) {
        throw new ValidationError("agent messages must reply to a group message");
      }
      const parent = db.select().from(messages).where(eq(messages.id, parentId)).get()!;
      const replyTo = input.replyToMessageId
        ? db.select().from(messages).where(eq(messages.id, input.replyToMessageId)).get()
        : null;
      if (replyTo && input.rootMessageId && rootMessageIdOf(replyTo) !== input.rootMessageId) {
        throw new ValidationError("rootMessageId does not match the reply target");
      }
      effectiveRoot = rootMessageIdOf(parent);
      hop = parent.hop + 1;
      if (hop > group.maxHops) {
        throw withParticipationReason(
          new ConflictError(
            `hop ${hop} exceeds the group limit of ${group.maxHops}; the discussion chain stopped`,
          ),
          "hop_limit",
        );
      }
      if (countAgentRepliesForRoot(db, effectiveRoot) >= group.maxRepliesPerRoot) {
        throw withParticipationReason(
          new ConflictError(
            `root ${effectiveRoot} already has ${group.maxRepliesPerRoot} agent replies`,
          ),
          "reply_budget",
        );
      }
      assertAgentRateLimit(db, input.actor.id, group.maxAgentMessagesPerMinute, ctx.now());
    }

    const maxSeq = db
      .select({ value: sql<number>`coalesce(max(${messages.seq}), 0)` })
      .from(messages)
      .where(eq(messages.groupId, input.groupId))
      .get();
    const seq = Number(maxSeq?.value ?? 0) + 1;
    const id = newId("msg");
    const now = ctx.now();
    try {
      db.insert(messages)
        .values({
          id,
          groupId: input.groupId,
          threadId: input.threadId ?? null,
          senderType: input.actor.type,
          senderId: input.actor.id,
          content,
          rootMessageId: effectiveRoot,
          replyToMessageId: input.replyToMessageId ?? null,
          hop,
          clientMessageId,
          seq,
          createdAt: now,
        })
        .run();
    } catch (error) {
      if (isUniqueViolation(error) && clientMessageId) {
        const existing = db
          .select()
          .from(messages)
          .where(
            and(eq(messages.groupId, input.groupId), eq(messages.clientMessageId, clientMessageId)),
          )
          .get();
        if (existing) return existing;
      }
      throw error;
    }

    const event = appendEvent(db, {
      type: "message.created",
      actor: input.actor,
      groupId: input.groupId,
      threadId: input.threadId ?? null,
      payload: {
        messageId: id,
        senderType: input.actor.type,
        senderId: input.actor.id,
        content,
        rootMessageId: effectiveRoot,
        replyToMessageId: input.replyToMessageId ?? null,
        hop,
        seq,
      },
      createdAt: now,
    });
    const saved = db.select().from(messages).where(eq(messages.id, id)).get()!;
    const decision = decideParticipation(ctx, db, {
      group,
      message: saved,
      presenceTtlMs: input.presenceTtlMs ?? AGENT_PRESENCE_TTL_MS,
    });
    if (
      decision.reason === "hop_limit" ||
      decision.reason === "reply_budget" ||
      decision.reason === "mode_disabled"
    ) {
      recordParticipationStop(db, {
        groupId: input.groupId,
        message: saved,
        reason: decision.reason,
        agentId: input.actor.type === "agent" ? input.actor.id : null,
        createdAt: now,
      });
    }
    for (const agentId of decision.agentIds) {
      enqueueDelivery(db, { agentId, eventId: event.id, createdAt: now });
    }
    return saved;
  });
}

export interface ListMessagesInput {
  groupId: string;
  viewer: Actor;
  limit?: number;
  cursor?: number;
}

export function listMessages(
  ctx: RoomContext,
  input: ListMessagesInput,
): { items: MessageRow[]; nextCursor: number | null } {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  requireGroupMember(ctx.db, input.groupId, input.viewer);
  const cursor = input.cursor ?? 0;
  const items = ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.groupId, input.groupId),
        gt(messages.seq, cursor),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(limit)
    .all();
  const last = items.at(-1);
  return { items, nextCursor: items.length === limit && last ? last.seq : null };
}

export function getMessage(
  ctx: RoomContext,
  input: { messageId: string; viewer: Actor },
): MessageRow {
  const message = ctx.db.select().from(messages).where(eq(messages.id, input.messageId)).get();
  if (!message) throw new NotFoundError(`message ${input.messageId} not found`);
  requireGroupMember(ctx.db, message.groupId, input.viewer);
  return message;
}

export function getGroupMessageRow(
  ctx: RoomContext,
  groupId: string,
  messageId: string,
): MessageRow {
  const message = ctx.db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!message) throw new NotFoundError(`message ${messageId} not found`);
  if (message.groupId !== groupId)
    throw new ValidationError("message belongs to a different group");
  return message;
}
