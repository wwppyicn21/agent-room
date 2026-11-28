import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@room/config";
import { type DatabaseHandle, migrationsFolder, openDatabase } from "@room/database";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(webRoot?: string) {
  const dir = mkdtempSync(join(tmpdir(), "agent-room-static-"));
  const handle: DatabaseHandle = openDatabase({ path: join(dir, "room.db"), migrationsFolder });
  cleanups.push(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const config = loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "dev",
    HOST: "127.0.0.1",
    DATABASE_PATH: join(dir, "room.db"),
    ...(webRoot ? { WEB_ROOT: webRoot } : {}),
  });
  return buildApp({ config, database: handle });
}

function webDir(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-room-web-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(root, "assets/app.js"), "console.log('room')");
  return root;
}

describe("production static web", () => {
  it("serves index.html at /", async () => {
    const app = await setup(webDir());
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("id=root");
  });

  it("serves immutable assets with a JavaScript content type", async () => {
    const app = await setup(webDir());
    const response = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/javascript");
    expect(response.headers["cache-control"]).toContain("immutable");
  });

  it("falls back to index.html for client routes but not for API routes", async () => {
    const app = await setup(webDir());
    const spa = await app.inject({ method: "GET", url: "/groups/grp_1" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("id=root");
    // API paths are never rewritten to index.html. Auth may answer first; the
    // important part is that the SPA shell is not returned.
    const api = await app.inject({ method: "GET", url: "/api/v1/missing" });
    expect([401, 404]).toContain(api.statusCode);
    expect(api.body).not.toContain("id=root");
  });

  it("rejects path traversal outside the web root", async () => {
    const app = await setup(webDir());
    const response = await app.inject({ method: "GET", url: "/..%2f..%2fetc%2fpasswd" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("root:");
  });

  it("keeps the JSON 404 when no web root is configured", async () => {
    const app = await setup();
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
