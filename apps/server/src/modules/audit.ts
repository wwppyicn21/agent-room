import { desc, eq } from "drizzle-orm";
import { type AuditLogRow, auditLogs } from "@room/database";
import { newId } from "@room/protocol";
import { auditMetadataSchema } from "@room/protocol";
import type { RoomContext, RoomDb } from "./context.js";
import { requireSystemAdmin } from "./permissions.js";

export interface AuditInput {
  actorType: "user" | "agent" | "system";
  actorId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/** Append an audit row. Must be called inside the same transaction as the change. */
export function recordAudit(db: RoomDb, input: AuditInput): AuditLogRow {
  const metadata = auditMetadataSchema.parse(input.metadata ?? {});
  const id = newId("aud");
  db.insert(auditLogs)
    .values({
      id,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: JSON.stringify(metadata),
      createdAt: input.createdAt,
    })
    .run();
  return db.select().from(auditLogs).where(eq(auditLogs.id, id)).get()!;
}

export function listAudit(
  ctx: RoomContext,
  input: { actorUserId: string; limit?: number },
): AuditLogRow[] {
  requireSystemAdmin(ctx.db, input.actorUserId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return ctx.db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit)
    .all();
}
