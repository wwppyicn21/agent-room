import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import { type DatabaseHandle, migrationsFolder, openDatabase } from "@room/database";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

interface Context {
  app: FastifyInstance;
  database: DatabaseHandle;
  directory: string;
}

const open: Context[] = [];

async function setup(): Promise<Context> {
  const directory = mkdtempSync(join(tmpdir(), "room-server-"));
  const database = openDatabase({ path: join(directory, "room.db"), migrationsFolder });
  const app = await buildApp({ config: loadConfig({ LOG_LEVEL: "silent" }), database });
  const context = { app, database, directory };
  open.push(context);
  return context;
}

afterEach(async () => {
  for (const context of open.splice(0)) {
    await context.app.close();
    context.database.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

describe("http surface", () => {
  it("serves a liveness probe", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("serves a readiness probe backed by SQLite", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", database: "ok" });
  });

  it("returns a structured 404", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("turns thrown errors into a structured 500", async () => {
    const { app } = await setup();
    app.get("/boom", async () => {
      throw new Error("boom");
    });
    const response = await app.inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "internal_error", message: "Internal Server Error" },
    });
  });
});
