import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@room/config";
import { externalIdentities, users } from "@room/database";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AccessTokenVerifier } from "../src/auth/access.js";
import { createUser } from "../src/modules/users.js";
import { createTestRoom, type TestRoom } from "./helpers.js";

const issuer = "https://team.cloudflareaccess.com";
const audience = "agent-room-test";

interface Harness {
  room: TestRoom;
  app: FastifyInstance;
  sign: (options?: { email?: string; audience?: string; expired?: boolean }) => Promise<string>;
}

const open: Harness[] = [];

async function setup(): Promise<Harness> {
  const { publicKey, privateKey } = await generateKeyPair("Ed25519");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "EdDSA", use: "sig" }] });
  const verifier = new AccessTokenVerifier({ issuer, audience, jwks });

  const room = createTestRoom();
  const app = await buildApp({
    config: loadConfig({
      LOG_LEVEL: "silent",
      NODE_ENV: "production",
      AUTH_MODE: "access",
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUDIENCE: audience,
    }),
    database: room.handle,
    accessVerifier: verifier,
  });
  const harness: Harness = {
    room,
    app,
    async sign(options = {}) {
      const token = new SignJWT({ email: options.email ?? "alice@example.com" })
        .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
        .setIssuer(issuer)
        .setAudience(options.audience ?? audience)
        .setSubject("access-subject-alice");
      if (options.expired) {
        token.setIssuedAt(Math.floor(Date.now() / 1000) - 3_600);
        token.setExpirationTime(Math.floor(Date.now() / 1000) - 1_800);
      } else {
        token.setIssuedAt();
        token.setExpirationTime("10m");
      }
      return token.sign(privateKey);
    },
  };
  open.push(harness);
  return harness;
}

function auth(token: string): { headers: Record<string, string> } {
  return { headers: { "cf-access-jwt-assertion": token } };
}

afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.app.close();
    harness.room.close();
  }
});

describe("Cloudflare Access authentication", () => {
  it("rejects requests without an Access JWT", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
  });

  it("maps a verified email to the matching room user and links the identity once", async () => {
    const { room, app, sign } = await setup();
    const user = createUser(room.ctx, {
      displayName: "Alice",
      email: "alice@example.com",
      role: "owner",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/me", ...auth(await sign()) });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: user.id, role: "owner" });
    expect(
      room.ctx.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, user.id))
        .all(),
    ).toHaveLength(1);

    const again = await app.inject({ method: "GET", url: "/api/v1/me", ...auth(await sign()) });
    expect(again.statusCode).toBe(200);
    expect(
      room.ctx.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, user.id))
        .all(),
    ).toHaveLength(1);
  });

  it("rejects unknown emails, disabled users, wrong audience and expired tokens", async () => {
    const { room, app, sign } = await setup();
    const alice = createUser(room.ctx, {
      displayName: "Alice",
      email: "alice@example.com",
      role: "owner",
    });
    const bob = createUser(room.ctx, {
      displayName: "Bob",
      email: "bob@example.com",
      role: "member",
      actorUserId: alice.id,
    });

    const stranger = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      ...auth(await sign({ email: "stranger@example.com" })),
    });
    expect(stranger.statusCode).toBe(401);

    room.ctx.db.update(users).set({ status: "disabled" }).where(eq(users.id, bob.id)).run();
    const disabled = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      ...auth(await sign({ email: "bob@example.com" })),
    });
    expect(disabled.statusCode).toBe(403);

    const wrongAudience = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      ...auth(await sign({ audience: "someone-else" })),
    });
    expect(wrongAudience.statusCode).toBe(401);

    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      ...auth(await sign({ expired: true })),
    });
    expect(expired.statusCode).toBe(401);
  });
});
