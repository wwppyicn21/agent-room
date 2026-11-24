import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import { migrationsFolder, openDatabase } from "@room/database";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createRoomContext } from "../src/modules/context.js";
import { createUser } from "../src/modules/users.js";

interface Route {
  method: string;
  path: string;
}

function openapiRoutes(spec: string): Route[] {
  const routes: Route[] = [];
  let current: string | null = null;
  for (const line of spec.split("\n")) {
    const pathMatch = /^ {2}(\/api\/v1\/[^:]+):$/.exec(line);
    if (pathMatch) {
      current = pathMatch[1]!;
      continue;
    }
    const methodMatch = /^ {4}(get|post|patch|put|delete):$/.exec(line);
    if (current && methodMatch) {
      routes.push({ method: methodMatch[1]!.toUpperCase(), path: current });
    }
  }
  return routes;
}

const harnesses: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function app(): Promise<FastifyInstance> {
  const directory = mkdtempSync(join(tmpdir(), "room-contract-"));
  const database = openDatabase({ path: join(directory, "room.db"), migrationsFolder });
  createUser(createRoomContext(database), { displayName: "owner", role: "owner" });
  const instance = await buildApp({
    config: loadConfig({ LOG_LEVEL: "silent", AUTH_MODE: "dev" }),
    database,
  });
  harnesses.push({
    app: instance,
    async close() {
      await instance.close();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  });
  return instance;
}

describe("OpenAPI contract", () => {
  it("documents the real thread close route and no shadow POST", () => {
    const spec = readFileSync(join(process.cwd(), "docs/openapi.yaml"), "utf8");
    const routes = openapiRoutes(spec);
    expect(routes).toContainEqual({ method: "POST", path: "/api/v1/threads/{threadId}/close" });
    expect(routes).not.toContainEqual({ method: "POST", path: "/api/v1/threads/{threadId}" });
    expect(routes).toContainEqual({ method: "GET", path: "/api/v1/agent/tasks" });
    expect(routes).toContainEqual({ method: "GET", path: "/api/v1/groups/{groupId}/workspaces" });
  });

  it("has a registered Fastify route for every documented operation", async () => {
    const instance = await app();
    const spec = readFileSync(join(process.cwd(), "docs/openapi.yaml"), "utf8");
    const missing: string[] = [];
    for (const route of openapiRoutes(spec)) {
      const url = route.path.replace(/\{[^}]+\}/g, "x");
      const response = await instance.inject({
        method: route.method as "GET",
        url,
        headers: { "content-type": "application/json" },
        ...(route.method === "GET" ? {} : { payload: {} }),
      });
      if (response.statusCode === 404) missing.push(`${route.method} ${route.path}`);
    }
    expect(missing).toEqual([]);
  });
});
