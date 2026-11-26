import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeliveryStore } from "../src/store.js";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "room-store-"));
}

describe("DeliveryStore concurrency and retention", () => {
  it("serializes concurrent writes without losing records", async () => {
    const path = join(temp(), "deliveries.json");
    const store = new DeliveryStore(path);
    await store.load();
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.begin(`evd_${index}`)));
    await store.flush();
    const reloaded = new DeliveryStore(path);
    await reloaded.load();
    expect(Object.keys(reloaded.counts()).length).toBeGreaterThan(0);
    for (let index = 0; index < 25; index += 1) {
      expect(reloaded.state(`evd_${index}`)).toBe("pending");
    }
  });

  it("does not overwrite concurrent updates of the same delivery", async () => {
    const path = join(temp(), "deliveries.json");
    const store = new DeliveryStore(path);
    await store.load();
    await Promise.all(Array.from({ length: 10 }, () => store.begin("evd_same")));
    await store.flush();
    expect(store.get("evd_same")?.attempts).toBe(10);
    const reloaded = new DeliveryStore(path);
    await reloaded.load();
    expect(reloaded.get("evd_same")?.attempts).toBe(10);
  });

  it("removes stale temporary files on load", async () => {
    const directory = temp();
    const path = join(directory, "deliveries.json");
    const stale = `${path}.999.stale.tmp`;
    writeFileSync(stale, "{}");
    const store = new DeliveryStore(path);
    await store.load();
    expect(existsSync(stale)).toBe(false);
  });

  it("keeps pending turns while pruning old terminal records", async () => {
    const path = join(temp(), "deliveries.json");
    const store = new DeliveryStore(path);
    await store.load();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await store.begin("old_done");
    await store.markCompleted("old_done", old);
    await store.begin("fresh_pending");
    await store.recordTurn({
      eventId: "old_turn",
      requestId: "room-old_turn",
      sessionId: "ses_1",
      groupId: "grp_1",
      threadId: null,
      replyToMessageId: null,
      messageId: null,
      prompt: "hello",
      text: "",
      state: "awaiting_response",
      createdAt: old,
      updatedAt: old,
    });
    await store.recordTurn({
      eventId: "old_completed_turn",
      requestId: "room-old_completed_turn",
      sessionId: "ses_1",
      groupId: "grp_1",
      threadId: null,
      replyToMessageId: null,
      messageId: null,
      prompt: "hello",
      text: "done",
      state: "completed",
      createdAt: old,
      updatedAt: old,
    });
    await store.prune({ retentionDays: 30 });
    expect(store.state("old_done")).toBeUndefined();
    expect(store.state("fresh_pending")).toBe("pending");
    expect(store.listTurns(["awaiting_response"])).toHaveLength(1);
    expect(store.getTurn("old_completed_turn")).toBeUndefined();
  });

  it("migrates version 1 files to version 2 on the next write", async () => {
    const path = join(temp(), "deliveries.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        deliveries: {
          evd_1: { state: "completed", attempts: 1, updatedAt: new Date().toISOString() },
        },
      }),
    );
    const store = new DeliveryStore(path);
    await store.load();
    expect(store.state("evd_1")).toBe("completed");
    await store.begin("evd_2");
    await store.flush();
    const reloaded = new DeliveryStore(path);
    await reloaded.load();
    expect(reloaded.state("evd_1")).toBe("completed");
    expect(reloaded.state("evd_2")).toBe("pending");
  });
});
