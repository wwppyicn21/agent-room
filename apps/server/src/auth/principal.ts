import type { UserRow } from "@room/database";
import type { RbacRole } from "@room/protocol";

/** Authenticated human user, resolved from Access JWT or the dev provider. */
export interface UserPrincipal {
  readonly type: "user";
  readonly userId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly role: RbacRole;
}

/** Authenticated agent connection (WSS), bound to the verified key's agent. */
export interface AgentPrincipal {
  readonly type: "agent";
  readonly agentId: string;
  readonly sessionId: string;
}

export type Principal = UserPrincipal | AgentPrincipal;

export function userPrincipalOf(row: UserRow): UserPrincipal {
  return {
    type: "user",
    userId: row.id,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
  };
}

export function principalUserId(principal: Principal | undefined): string {
  if (!principal || principal.type !== "user") {
    throw new Error("a user principal is required");
  }
  return principal.userId;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}
