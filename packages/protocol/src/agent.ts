import { z } from "zod";

/**
 * Version of the Agent <-> Room protocol. Every cross-process message carries it
 * (plan §7.1); bump it only for breaking changes and document the migration.
 */
export const AGENT_PROTOCOL_VERSION = 1;

/** Purpose string bound into every signed challenge (plan §8.5). */
export const AGENT_AUTH_PURPOSE = "agent-connect";

export const AGENT_CHALLENGE_TTL_MS = 60_000;
export const AGENT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const AGENT_PRESENCE_TTL_MS = 60_000;
export const AGENT_HEARTBEAT_MS = 20_000;

/**
 * Canonical byte string signed by an Agent to prove possession of its private
 * key. It lives in the protocol package so the Server, the Agent SDK and the
 * mock agent cannot drift apart.
 */
export interface AgentChallengeFields {
  serverId: string;
  challengeId: string;
  nonce: string;
  clientNonce: string;
  agentId: string;
  keyFingerprint: string;
  expiresAt: number;
  purpose: string;
  protocolVersion: number;
}

export function buildAgentChallengeString(fields: AgentChallengeFields): string {
  return [
    "agentroom-agent-connect-v1",
    `serverId=${fields.serverId}`,
    `challengeId=${fields.challengeId}`,
    `nonce=${fields.nonce}`,
    `clientNonce=${fields.clientNonce}`,
    `agentId=${fields.agentId}`,
    `keyFingerprint=${fields.keyFingerprint}`,
    `expiresAt=${fields.expiresAt}`,
    `purpose=${fields.purpose}`,
    `protocolVersion=${fields.protocolVersion}`,
  ].join("\n");
}

export const agentChallengeRequestSchema = z.object({
  /** Fingerprint of the registered Ed25519 public key (SPKI DER, SHA-256 hex). */
  fingerprint: z.string().trim().min(16).max(128),
  /** Optional hint; identity is still derived from the key, never from this. */
  agentId: z.string().trim().max(64).optional(),
  clientNonce: z.string().trim().max(128).optional(),
});
export type AgentChallengeRequest = z.infer<typeof agentChallengeRequestSchema>;

export const agentChallengeResponseSchema = z.object({
  protocolVersion: z.number().int(),
  serverId: z.string(),
  challengeId: z.string(),
  nonce: z.string(),
  clientNonce: z.string(),
  agentId: z.string(),
  keyFingerprint: z.string(),
  expiresAt: z.string(),
  purpose: z.string(),
});
export type AgentChallengeResponse = z.infer<typeof agentChallengeResponseSchema>;

export const agentConnectRequestSchema = z.object({
  challengeId: z.string().trim().min(1).max(64),
  /** Base64 signature over buildAgentChallengeString(...). */
  signature: z.string().trim().min(16).max(2048),
  clientNonce: z.string().trim().max(128).optional(),
});
export type AgentConnectRequest = z.infer<typeof agentConnectRequestSchema>;

export const agentConnectResponseSchema = z.object({
  protocolVersion: z.number().int(),
  sessionToken: z.string(),
  expiresAt: z.string(),
  agent: z.object({
    id: z.string(),
    displayName: z.string(),
    runtime: z.string(),
    capabilities: z.array(z.string()),
  }),
});
export type AgentConnectResponse = z.infer<typeof agentConnectResponseSchema>;

export const agentServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.number().int(),
    serverId: z.string(),
    heartbeatMs: z.number().int().positive(),
    sessionExpiresAt: z.string(),
    agent: z.object({
      id: z.string(),
      displayName: z.string(),
      runtime: z.string(),
      capabilities: z.array(z.string()),
    }),
    outstanding: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("event.deliver"),
    protocolVersion: z.number().int(),
    deliveryId: z.string(),
    event: z.object({
      eventId: z.string(),
      eventType: z.string(),
      timestamp: z.string(),
      correlationId: z.string(),
      causationId: z.string().nullable(),
      groupId: z.string().nullable(),
      threadId: z.string().nullable(),
      taskId: z.string().nullable(),
      payload: z.record(z.string(), z.unknown()),
    }),
  }),
  z.object({
    type: z.literal("ack.ok"),
    deliveryIds: z.array(z.string()),
  }),
  z.object({
    type: z.literal("pong"),
    time: z.string(),
    serverId: z.string(),
  }),
  z.object({
    type: z.literal("message.sent"),
    messageId: z.string(),
    seq: z.number().int(),
    clientMessageId: z.string().nullable(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type AgentServerMessage = z.infer<typeof agentServerMessageSchema>;

export const agentClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("event.ack"),
    deliveryIds: z.array(z.string()).min(1).max(200),
  }),
  z.object({
    type: z.literal("ping"),
  }),
  z.object({
    type: z.literal("message.send"),
    groupId: z.string(),
    content: z.string().trim().min(1).max(20_000),
    threadId: z.string().nullable().optional(),
    rootMessageId: z.string().nullable().optional(),
    replyToMessageId: z.string().nullable().optional(),
    clientMessageId: z.string().trim().max(200).nullable().optional(),
  }),
  z.object({
    type: z.literal("agent.status"),
    status: z.enum(["online", "offline"]),
  }),
]);
export type AgentClientMessage = z.infer<typeof agentClientMessageSchema>;
