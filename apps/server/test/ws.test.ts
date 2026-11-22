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
  port: number;
}

const open: Context[] = [];

function nextJson(socket: WebSocket, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
        } catch (error) {
          reject(error as Error);
        }
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("websocket error"));
      },
      { once: true },
    );
  });
}

async function start(): Promise<Context> {
  const directory = mkdtempSync(join(tmpdir(), "room-ws-"));
  const database = openDatabase({ path: join(directory, "room.db"), migrationsFolder });
  const app = await buildApp({ config: loadConfig({ LOG_LEVEL: "silent" }), database });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no listen address");
  const context = { app, database, directory, port: address.port };
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

describe("websocket", () => {
  it("greets the client, answers ping and closes cleanly", async () => {
    const { port } = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const hello = await nextJson(socket);
    expect(hello.type).toBe("hello");
    expect(hello.server).toBe("agent-room");

    socket.send(JSON.stringify({ type: "ping" }));
    const pong = await nextJson(socket);
    expect(pong.type).toBe("pong");

    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close();
    await closed;
  });

  it("rejects malformed payloads", async () => {
    const { port } = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await nextJson(socket);

    socket.send("not json");
    const error = await nextJson(socket);
    expect(error).toMatchObject({ type: "error", code: "invalid_json" });

    socket.send(JSON.stringify({ type: "unknown" }));
    const unknown = await nextJson(socket);
    expect(unknown).toMatchObject({ type: "error", code: "unknown_type" });

    socket.close();
  });
});
