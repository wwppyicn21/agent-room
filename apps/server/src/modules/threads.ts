import { and, desc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { messages, tasks, type TaskRow, threads, type ThreadRow } from "@room/database";
import { newId } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { recordAudit } from "./audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { appendEvent } from "./events.js";
import { getGroupMessageRow } from "./messages.js";
import {
  type Actor,
  requireActiveGroup,
  requireGroupManager,
  requireGroupMember,
  requireWriteUser,
  validateTitle,
} from "./permissions.js";

export function createThread(
  ctx: RoomContext,
  input: {
    groupId: string;
    sourceMessageId: string;
    title: string;
    createdByUserId: string;
  },
): ThreadRow {
  requireWriteUser(ctx.db, input.createdByUserId);
  requireGroupMember(ctx.db, input.groupId, { type: "user", id: input.createdByUserId });
  requireActiveGroup(ctx.db, input.groupId);
  getGroupMessageRow(ctx, input.groupId, input.sourceMessageId);
  const title = validateTitle(input.title, "title");
  const now = ctx.now();
  const id = newId("thr");
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.insert(threads)
      .values({
        id,
        groupId: input.groupId,
        sourceMessageId: input.sourceMessageId,
        title,
        status: "open",
        createdByUserId: input.createdByUserId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    appendEvent(db, {
      type: "thread.created",
      actor: { type: "user", id: input.createdByUserId },
      groupId: input.groupId,
      threadId: id,
      payload: { threadId: id, sourceMessageId: input.sourceMessageId, title },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.createdByUserId,
      action: "thread.create",
      targetType: "thread",
      targetId: id,
      metadata: { groupId: input.groupId, sourceMessageId: input.sourceMessageId },
      createdAt: now,
    });
    return db.select().from(threads).where(eq(threads.id, id)).get()!;
  });
}

export function getThread(ctx: RoomContext, input: { threadId: string; viewer: Actor }): ThreadRow {
  const thread = ctx.db.select().from(threads).where(eq(threads.id, input.threadId)).get();
  if (!thread) throw new NotFoundError(`thread ${input.threadId} not found`);
  requireGroupMember(ctx.db, thread.groupId, input.viewer);
  return thread;
}

export function listThreads(
  ctx: RoomContext,
  input: {
    groupId: string;
    viewer: Actor;
    status?: ThreadRow["status"];
    limit?: number;
    cursor?: string | null;
  },
): { items: ThreadRow[]; nextCursor: string | null } {
  requireGroupMember(ctx.db, input.groupId, input.viewer);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const conditions = [eq(threads.groupId, input.groupId)];
  if (input.status) conditions.push(eq(threads.status, input.status));
  if (input.cursor) {
    const cursor = ctx.db.select().from(threads).where(eq(threads.id, input.cursor)).get();
    if (!cursor || cursor.groupId !== input.groupId) {
      throw new ValidationError("cursor is not a thread of this group");
    }
    conditions.push(
      or(
        lt(threads.createdAt, cursor.createdAt),
        and(eq(threads.createdAt, cursor.createdAt), lt(threads.id, cursor.id)),
      )!,
    );
  }
  const items = ctx.db
    .select()
    .from(threads)
    .where(and(...conditions))
    .orderBy(desc(threads.createdAt), desc(threads.id))
    .limit(limit)
    .all();
  const last = items.at(-1);
  return { items, nextCursor: items.length === limit && last ? last.id : null };
}

export function closeThread(
  ctx: RoomContext,
  input: { threadId: string; actorUserId: string },
): ThreadRow {
  requireWriteUser(ctx.db, input.actorUserId);
  const thread = getThread(ctx, {
    threadId: input.threadId,
    viewer: { type: "user", id: input.actorUserId },
  });
  if (thread.status === "closed") return thread;
  requireActiveGroup(ctx.db, thread.groupId);
  const isCreator = thread.createdByUserId === input.actorUserId;
  if (!isCreator) {
    requireGroupManager(ctx.db, thread.groupId, { type: "user", id: input.actorUserId });
  }
  const activeTask = ctx.db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.threadId, thread.id),
        notInArray(tasks.status, ["succeeded", "failed", "cancelled"]),
      ),
    )
    .get();
  if (activeTask) {
    throw new ConflictError(
      `thread ${thread.id} belongs to active task ${activeTask.id} (${activeTask.status})`,
    );
  }
  const now = ctx.now();
  return ctx.db.transaction((transaction) => {
    const db = transaction as unknown as RoomDb;
    db.update(threads)
      .set({ status: "closed", closedAt: now, updatedAt: now })
      .where(eq(threads.id, thread.id))
      .run();
    appendEvent(db, {
      type: "thread.closed",
      actor: { type: "user", id: input.actorUserId },
      groupId: thread.groupId,
      threadId: thread.id,
      payload: { threadId: thread.id },
      createdAt: now,
    });
    recordAudit(db, {
      actorType: "user",
      actorId: input.actorUserId,
      action: "thread.close",
      targetType: "thread",
      targetId: thread.id,
      metadata: { groupId: thread.groupId },
      createdAt: now,
    });
    return db.select().from(threads).where(eq(threads.id, thread.id)).get()!;
  });
}

export interface ThreadDetail {
  thread: ThreadRow;
  sourceMessage: typeof messages.$inferSelect | null;
  messageCount: number;
  lastMessageAt: number | null;
  task: TaskRow | null;
}

export function getThreadDetail(
  ctx: RoomContext,
  input: { threadId: string; viewer: Actor },
): ThreadDetail {
  const thread = getThread(ctx, input);
  const sourceMessage =
    ctx.db.select().from(messages).where(eq(messages.id, thread.sourceMessageId)).get() ?? null;
  const count = ctx.db
    .select({ value: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.threadId, thread.id), isNull(messages.deletedAt)))
    .get();
  const last = ctx.db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.threadId, thread.id), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt), desc(messages.seq))
    .limit(1)
    .get();
  const task =
    ctx.db
      .select()
      .from(tasks)
      .where(eq(tasks.threadId, thread.id))
      .orderBy(desc(tasks.createdAt))
      .limit(1)
      .get() ?? null;
  return {
    thread,
    sourceMessage,
    messageCount: Number(count?.value ?? 0),
    lastMessageAt: last?.createdAt ?? null,
    task,
  };
}

export function findOpenThreadForSource(
  ctx: RoomContext,
  groupId: string,
  sourceMessageId: string,
): ThreadRow | undefined {
  return ctx.db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.groupId, groupId),
        eq(threads.sourceMessageId, sourceMessageId),
        eq(threads.status, "open"),
      ),
    )
    .get();
}

export function assertThreadInGroup(thread: ThreadRow, groupId: string): void {
  if (thread.groupId !== groupId) throw new ForbiddenError("thread belongs to a different group");
}
