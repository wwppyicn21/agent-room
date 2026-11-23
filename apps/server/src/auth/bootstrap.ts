import { users } from "@room/database";
import { createUser } from "../modules/users.js";
import type { RoomContext } from "../modules/context.js";
import type { UserRow } from "@room/database";

/**
 * One-time owner bootstrap from server-side configuration (plan §8.1). It only
 * runs while the room has no users at all; afterwards the normal RBAC rules
 * apply and the environment value is ignored.
 */
export function ensureBootstrapOwner(
  ctx: RoomContext,
  input: { email?: string },
  log?: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void },
): UserRow | null {
  const existing = ctx.db.select({ id: users.id }).from(users).limit(1).get();
  if (existing) return null;
  if (!input.email) {
    log?.warn({}, "room has no users and BOOTSTRAP_OWNER_EMAIL is unset; nobody can sign in");
    return null;
  }
  const user = createUser(ctx, {
    displayName: input.email.split("@")[0] || "owner",
    email: input.email.toLowerCase(),
    role: "owner",
  });
  log?.info({ userId: user.id, email: user.email }, "bootstrap owner created");
  return user;
}
