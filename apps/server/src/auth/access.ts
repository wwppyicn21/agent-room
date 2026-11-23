import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { RoomContext } from "../modules/context.js";
import { ForbiddenError, UnauthorizedError } from "../modules/errors.js";
import {
  findUserByEmail,
  findUserByExternalIdentity,
  linkExternalIdentity,
} from "../modules/users.js";
import { type UserPrincipal, userPrincipalOf } from "./principal.js";

export interface AccessIdentity {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
}

/**
 * Cloudflare Access JWT verification (plan §8.1): signature via the team's
 * JWKS, plus issuer, audience, expiry and not-before checks. A header's mere
 * presence is never trusted.
 */
export class AccessTokenVerifier {
  private readonly jwks: JWTVerifyGetKey;

  constructor(
    private readonly options: {
      issuer: string;
      audience: string;
      /** Injectable JWKS for tests; production uses the remote team JWKS. */
      jwks?: JWTVerifyGetKey;
    },
  ) {
    this.jwks =
      options.jwks ??
      createRemoteJWKSet(new URL(`${options.issuer.replace(/\/+$/, "")}/cdn-cgi/access/certs`));
  }

  async verify(token: string): Promise<AccessIdentity> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        clockTolerance: 5,
      });
      payload = result.payload as Record<string, unknown>;
    } catch {
      throw new UnauthorizedError("invalid Cloudflare Access token");
    }
    const subject = typeof payload.sub === "string" ? payload.sub : undefined;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    if (!subject || !email) {
      throw new UnauthorizedError("Access token is missing sub or email");
    }
    const issuer = typeof payload.iss === "string" ? payload.iss : this.options.issuer;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    return {
      issuer,
      subject,
      email,
      displayName: name ?? email.split("@")[0] ?? "user",
    };
  }
}

/**
 * Map a verified Access identity to a room user. First login of a user whose
 * email matches an existing account links the external identity automatically;
 * access is never granted to an unknown email.
 */
export function resolveAccessUser(ctx: RoomContext, identity: AccessIdentity): UserPrincipal {
  const linked = findUserByExternalIdentity(ctx, {
    issuer: identity.issuer,
    subject: identity.subject,
  });
  if (linked) {
    if (linked.status !== "active") throw new ForbiddenError(`user ${linked.id} is disabled`);
    return userPrincipalOf(linked);
  }
  const byEmail = findUserByEmail(ctx, identity.email);
  if (!byEmail) {
    throw new UnauthorizedError(
      `no room account is mapped to ${identity.email}; ask an owner or admin to invite you`,
    );
  }
  if (byEmail.status !== "active") throw new ForbiddenError(`user ${byEmail.id} is disabled`);
  try {
    linkExternalIdentity(ctx, {
      userId: byEmail.id,
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
    });
  } catch (error) {
    const again = findUserByExternalIdentity(ctx, {
      issuer: identity.issuer,
      subject: identity.subject,
    });
    if (!again) throw error;
  }
  return userPrincipalOf(byEmail);
}
