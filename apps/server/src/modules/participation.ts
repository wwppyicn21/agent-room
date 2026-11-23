import { and, eq, isNull, sql } from "drizzle-orm";
import { agents, groupMembers, messages, type GroupRow } from "@room/database";
import type { EventRow, MessageRow } from "@room/database";
import type { RoomContext, RoomDb } from "./context.js";
import { RateLimitError } from "./errors.js";
import { appendEvent } from "./events.js";
import { liveSessionAgentIds } from "./agentAuth.js";

/**
 * AI participation engine (plan §5.5, §9). It only decides *who may receive*
 * a message; the receiving Agent still chooses to reply or skip.
 */
export interface ParticipationDecision {
  agentIds: string[];
  /** Diagnostic reason, never exposed as a public chat message. */
  reason:
    | "delivered"
    | "thread_message"
    | "system_sender"
    | "mode_disabled"
    | "agent_messages_disallowed"
    | "hop_limit"
    | "reply_budget"
    | "no_online_agents"
    | "no_mentions";
}

/** Top-level messages are their own root; replies point at the original root. */
export function rootMessageIdOf(message: Pick<MessageRow, "id" | "rootMessageId">): string {
  return message.rootMessageId ?? message.id;
}

export function countAgentRepliesForRoot(db: RoomDb, rootMessageId: string): number {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.rootMessageId, rootMessageId),
        eq(messages.senderType, "agent"),
        isNull(messages.deletedAt),
      ),
    )
    .get();
  return Number(row?.value ?? 0);
}

export function countRecentAgentMessages(db: RoomDb, agentId: string, since: number): number {
  const row = db
    .select({ value: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.senderType, "agent"),
        eq(messages.senderId, agentId),
        sql`${messages.createdAt} > ${since}`,
        isNull(messages.deletedAt),
      ),
    )
    .get();
  return Number(row?.value ?? 0);
}

/** Per-Agent reply rate across all groups (plan §9.2 table). */
export function assertAgentRateLimit(
  db: RoomDb,
  agentId: string,
  limitPerMinute: number,
  now: number,
): void {
  const recent = countRecentAgentMessages(db, agentId, now - 60_000);
  if (recent >= limitPerMinute) {
    throw new RateLimitError(
      `agent ${agentId} exceeded ${limitPerMinute} messages per minute; wait before replying again`,
    );
  }
}

function mentions(content: string, displayName: string): boolean {
  const escaped = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])@${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(content);
}

export function decideParticipation(
  ctx: RoomContext,
  db: RoomDb,
  input: { group: GroupRow; message: MessageRow; presenceTtlMs: number },
): ParticipationDecision {
  const { group, message } = input;
  const none = (reason: ParticipationDecision["reason"]): ParticipationDecision => ({
    agentIds: [],
    reason,
  });

  if (message.threadId !== null) return none("thread_message");
  if (message.senderType === "system") return none("system_sender");
  if (group.participationMode === "disabled") return none("mode_disabled");
  if (message.senderType === "agent" && !group.allowAgentMessages) {
    return none("agent_messages_disallowed");
  }
  if (message.hop > group.maxHops) return none("hop_limit");

  const rootId = rootMessageIdOf(message);
  if (
    message.senderType === "agent" &&
    countAgentRepliesForRoot(db, rootId) >= group.maxRepliesPerRoot
  ) {
    return none("reply_budget");
  }

  const online = liveSessionAgentIds(ctx, input.presenceTtlMs);
  const members = db
    .select({ id: agents.id, displayName: agents.displayName, status: agents.status })
    .from(groupMembers)
    .innerJoin(agents, eq(groupMembers.memberId, agents.id))
    .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.memberType, "agent")))
    .all();

  let candidates = members.filter(
    (agent) => agent.status !== "disabled" && online.has(agent.id) && agent.id !== message.senderId,
  );
  if (candidates.length === 0) return none("no_online_agents");

  if (group.participationMode === "mention") {
    const mentioned = candidates.filter((agent) => mentions(message.content, agent.displayName));
    if (mentioned.length === 0) return none("no_mentions");
    candidates = mentioned;
  }

  return { agentIds: candidates.map((agent) => agent.id), reason: "delivered" };
}

/**
 * Internal diagnostic for a stopped participation chain (plan §9.2). It is an
 * event, never a public message, and it creates no Agent delivery. Payloads
 * deliberately omit message content and any credentials.
 */
export function recordParticipationStop(
  db: RoomDb,
  input: {
    groupId: string;
    message: Pick<MessageRow, "id" | "rootMessageId" | "senderType" | "senderId">;
    reason: string;
    agentId?: string | null;
    createdAt: number;
  },
): EventRow {
  return appendEvent(db, {
    type: "participation.stopped",
    actor: { type: "system", id: "participation-engine" },
    groupId: input.groupId,
    payload: {
      reason: input.reason,
      rootMessageId: rootMessageIdOf(input.message),
      senderType: input.message.senderType,
      senderId: input.message.senderId,
      agentId: input.agentId ?? null,
    },
    createdAt: input.createdAt,
  });
}

/** Reason attached to a rejected Agent send, used for the diagnostic event. */
export function withParticipationReason<T extends Error>(error: T, reason: string): T {
  (error as T & { participationReason?: string }).participationReason = reason;
  return error;
}

export function participationReasonOf(error: unknown): string | null {
  if (error instanceof RateLimitError) return "rate_limit";
  const reason = (error as { participationReason?: unknown } | null)?.participationReason;
  return typeof reason === "string" ? reason : null;
}
