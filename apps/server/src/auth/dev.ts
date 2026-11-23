import { findUserByEmail, findUserById } from "../modules/users.js";
import type { RoomContext } from "../modules/context.js";
import { ForbiddenError, UnauthorizedError } from "../modules/errors.js";
import { type UserPrincipal, userPrincipalOf } from "./principal.js";

type Headers = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Explicitly isolated development provider (plan §8.1): the caller names a
 * provisioned user via `x-dev-user-id` or `x-dev-user-email`. It never creates
 * users and is rejected in production by the config layer.
 */
export function resolveDevPrincipal(ctx: RoomContext, headers: Headers): UserPrincipal {
  const userId = first(headers["x-dev-user-id"])?.trim();
  const email = first(headers["x-dev-user-email"])?.trim();
  let user = userId ? findUserById(ctx, userId) : undefined;
  if (!user && email) user = findUserByEmail(ctx, email);
  if (!user) {
    throw new UnauthorizedError(
      "dev auth: provide x-dev-user-id (or x-dev-user-email) of a provisioned user",
    );
  }
  if (user.status !== "active") throw new ForbiddenError(`user ${user.id} is disabled`);
  return userPrincipalOf(user);
}
