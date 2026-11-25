import { z } from "zod";

export const RBAC_ROLES = ["owner", "admin", "member", "readonly"] as const;
export const rbacRoleSchema = z.enum(RBAC_ROLES);
export type RbacRole = z.infer<typeof rbacRoleSchema>;

export const USER_STATUSES = ["active", "disabled"] as const;
export const userStatusSchema = z.enum(USER_STATUSES);

export const GROUP_STATUSES = ["active", "archived"] as const;
export const groupStatusSchema = z.enum(GROUP_STATUSES);

export const PARTICIPATION_MODES = ["all", "mention", "disabled"] as const;
export const participationModeSchema = z.enum(PARTICIPATION_MODES);

export const MEMBER_TYPES = ["user", "agent"] as const;
export const memberTypeSchema = z.enum(MEMBER_TYPES);

export const GROUP_ROLES = ["owner", "admin", "member"] as const;
export const groupRoleSchema = z.enum(GROUP_ROLES);

export const SENDER_TYPES = ["user", "agent", "system"] as const;
export const senderTypeSchema = z.enum(SENDER_TYPES);

export const TASK_STATUSES = [
  "queued",
  "assigned",
  "running",
  "waiting_approval",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);

export const TASK_RUN_STATUSES = ["running", "paused", "succeeded", "failed", "cancelled"] as const;
export const taskRunStatusSchema = z.enum(TASK_RUN_STATUSES);

export const DELIVERY_STATUSES = ["pending", "delivered", "acked", "failed"] as const;
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);

/** Group-level AI participation policy (plan §5.2). */
export const groupAISettingsSchema = z.object({
  participationMode: participationModeSchema,
  allowAgentMessages: z.boolean(),
  maxHops: z.number().int().min(0).max(50),
  maxRepliesPerRoot: z.number().int().min(1).max(1000),
  maxAgentMessagesPerMinute: z.number().int().min(1).max(1000),
  maxTokensPerRoot: z.number().int().positive().max(10_000_000).optional(),
});
export type GroupAISettings = z.infer<typeof groupAISettingsSchema>;

export const DEFAULT_GROUP_AI_SETTINGS: GroupAISettings = {
  participationMode: "all",
  allowAgentMessages: true,
  maxHops: 4,
  maxRepliesPerRoot: 20,
  maxAgentMessagesPerMinute: 10,
};

export const agentCapabilitiesSchema = z.array(z.string().min(1).max(64)).max(64);

export const messageContentSchema = z.string().trim().min(1).max(20_000);

export const eventPayloadSchema = z.record(z.string(), z.unknown());
export type EventPayload = z.infer<typeof eventPayloadSchema>;

export const auditMetadataSchema = z.record(z.string(), z.unknown());
export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

export const EVENT_TYPES = [
  "user.created",
  "user.role_changed",
  "user.disabled",
  "user.enabled",
  "identity.linked",
  "group.created",
  "group.updated",
  "group.member_added",
  "group.member_removed",
  "group.member_updated",
  "agent.registered",
  "agent.key_registered",
  "agent.key_revoked",
  "agent.status.changed",
  "message.created",
  "message.deleted",
  "participation.stopped",
  "thread.created",
  "thread.closed",
  "task.created",
  "task.assigned",
  "task.started",
  "task.completed",
  "task.failed",
  "task.progress",
  "task.paused",
  "task.resumed",
  "task.cancelled",
  "task.approval_requested",
  "task.approval_decided",
  "task.approval_expired",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
