import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentClientOptions, AgentEvent, AgentTaskView } from "@room/agent-sdk";
import {
  RoomBridge,
  type DshContextLike,
  type DshSessionEvent,
  type RoomClientLike,
} from "../src/bridge.js";
import { assertMappings } from "../src/config.js";
import { ensureAgentKey, loadAgentKey } from "../src/keys.js";
import { DeliveryStore } from "../src/store.js";

class FakeClient implements RoomClientLike {
  connected = false;
  openCalls = 0;
  failSend = false;
  connectDelayMs = 0;
  sent: { groupId: string; content: string; options?: Record<string, unknown> }[] = [];
  options: AgentClientOptions | undefined;
  async connect(): Promise<void> {
    if (this.connectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    }
    this.connected = true;
  }
  async open(): Promise<{ agentId: string }> {
    this.openCalls += 1;
    return { agentId: "agt_self" };
  }
  close(): void {
    this.connected = false;
  }
  sendMessage(groupId: string, content: string, options?: Record<string, unknown>): void {
    if (this.failSend) throw new Error("socket is not open");
    this.sent.push({ groupId, content, options });
  }
}

interface Harness {
  bridge: RoomBridge;
  client: FakeClient;
  prompts: { requestId: string; sessionId: string; content: { type: string; text: string }[] }[];
  cancels: { sessionId: string }[];
  deliver: (event: AgentEvent) => Promise<void>;
  cancel: (command: {
    commandId: string;
    type: "task.cancel";
    taskId: string;
    runId: string | null;
    reason: string | null;
    createdAt: string;
  }) => Promise<void>;
  recover: (tasks: AgentTaskView[]) => void;
  emit: (sessionId: string, event: DshSessionEvent) => void;
  controller: {
    prompt: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    resolveAgent: ReturnType<typeof vi.fn>;
  };
  temp: string;
}

function makeHarness(
  groups: { groupId: string; sessionId: string; label?: string }[],
  options: {
    readSession?: (id: string) => Promise<unknown>;
    temp?: string;
    resolveAgentError?: boolean;
    turnTimeoutMs?: number;
    connectDelayMs?: number;
  } = {},
): Harness {
  const temp = options.temp ?? mkdtempSync(join(tmpdir(), "room-dsh-plugin-"));
  const prompts: Harness["prompts"] = [];
  const cancels: Harness["cancels"] = [];
  const listeners: ((session: { id: string }, event: DshSessionEvent) => void)[] = [];
  const controller = {
    prompt: vi.fn(async (request: (typeof prompts)[number]) => {
      prompts.push(request);
      return { accepted: true as const };
    }),
    cancel: vi.fn((input: { sessionId: string }) => {
      cancels.push(input);
    }),
    resolveAgent: vi.fn(async () =>
      options.resolveAgentError
        ? { error: { code: "session/not-found", message: "no agent" } }
        : { agent: { id: "agent" } },
    ),
  };
  const readSession = options.readSession ?? (async () => ({ id: "ok" }));
  const client = new FakeClient();
  client.connectDelayMs = options.connectDelayMs ?? 0;
  const ctx: DshContextLike = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (service: string) => {
      if (service === "sessionController") return controller;
      if (service === "sessionQuery") return { readSession };
      return undefined;
    },
    effect: () => {},
    on: (_name, listener) => {
      listeners.push(listener);
      return () => {};
    },
  };
  const bridge = new RoomBridge(
    {
      enabled: true,
      roomBaseUrl: "http://127.0.0.1:1",
      agentKeyPath: join(temp, "agent-key.pem"),
      dataDir: temp,
      groups: groups.map((group) => ({ ...group, label: group.label ?? "" })),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    },
    {
      ctx,
      createClient: (clientOptions) => {
        client.options = clientOptions;
        return client;
      },
      readSession,
    },
  );
  const onEvent = () => {
    if (!client.options?.onEvent) throw new Error("onEvent was not wired");
    return client.options.onEvent;
  };
  return {
    bridge,
    client,
    prompts,
    cancels,
    controller,
    temp,
    deliver: async (event) => {
      await onEvent()(event, { deliveryId: event.eventId, attempt: 1 });
    },
    cancel: async (command) => {
      if (!client.options?.onTaskCancel) throw new Error("onTaskCancel was not wired");
      await client.options.onTaskCancel(command);
    },
    recover: (tasks) => {
      if (!client.options?.onRecover) throw new Error("onRecover was not wired");
      client.options.onRecover(tasks);
    },
    emit: (sessionId, event) => {
      for (const listener of listeners) listener({ id: sessionId }, event);
    },
  };
}

function messageEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    eventId: "evd_1",
    eventType: "message.created",
    timestamp: "2026-01-01T00:00:00.000Z",
    correlationId: "cor_1",
    causationId: null,
    groupId: "grp_a",
    threadId: null,
    taskId: null,
    payload: {
      messageId: "msg_1",
      senderType: "user",
      senderId: "usr_1",
      content: "hello room",
      replyToMessageId: null,
    },
    ...overrides,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("DSH plugin bridge", () => {
  it("prompts the explicitly mapped session and records completed delivery", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a", label: "Alpha" }]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);

    await harness.deliver(messageEvent());

    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toMatchObject({
      requestId: "room-evd_1",
      sessionId: "ses_a",
      mode: "queue",
    });
    expect(harness.prompts[0]?.content[0]?.text).toContain("Alpha");
    expect(harness.prompts[0]?.content[0]?.text).toContain("hello room");
    expect(harness.bridge.deliveryStore.state("evd_1")).toBe("completed");
    await harness.bridge.stop();
  });

  it("resumes the mapped session agent before prompting", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);

    await harness.deliver(messageEvent());

    expect(harness.controller.resolveAgent).toHaveBeenCalledWith("ses_a");
    expect(harness.controller.resolveAgent.mock.invocationCallOrder[0]).toBeLessThan(
      harness.controller.prompt.mock.invocationCallOrder[0]!,
    );
    expect(harness.prompts).toHaveLength(1);
    await harness.bridge.stop();
  });

  it("fails without prompting when the mapped session agent cannot resume", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }], {
      resolveAgentError: true,
    });
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);

    await harness.deliver(messageEvent());

    expect(harness.prompts).toHaveLength(0);
    expect(harness.bridge.deliveryStore.state("evd_1")).toBe("failed");
    expect(harness.bridge.status().lastError).toContain("agent is unavailable");
    await harness.bridge.stop();
  });

  it("persists a timed out turn as failed and ignores late events", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }], { turnTimeoutMs: 40 });
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);

    await harness.deliver(messageEvent());
    expect(harness.prompts).toHaveLength(1);
    await waitFor(() => harness.bridge.deliveryStore.getTurn("evd_1")?.state === "failed");
    expect(harness.bridge.deliveryStore.getTurn("evd_1")?.error).toBe("turn_timeout");
    await harness.bridge.deliveryStore.flush();

    const reloaded = new DeliveryStore(join(harness.temp, "deliveries.json"));
    await reloaded.load();
    expect(reloaded.getTurn("evd_1")?.state).toBe("failed");

    harness.emit("ses_a", {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "late reply" }] } },
    });
    harness.emit("ses_a", { type: "turn/end", data: { reason: { kind: "completed" } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.client.sent).toHaveLength(0);
    expect(harness.bridge.deliveryStore.getTurn("evd_1")?.state).toBe("failed");
    await harness.bridge.stop();
  });

  it("clears pending timers on stop without marking the turn failed", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }], { turnTimeoutMs: 40 });
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);
    await harness.deliver(messageEvent());
    await harness.bridge.stop();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(harness.bridge.deliveryStore.getTurn("evd_1")?.state).toBe("awaiting_response");
  });

  it("fails without prompting when the group has no mapping", async () => {
    const harness = makeHarness([]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);

    await harness.deliver(messageEvent({ groupId: "grp_missing" }));

    expect(harness.prompts).toHaveLength(0);
    expect(harness.bridge.deliveryStore.state("evd_1")).toBe("failed");
    expect(harness.bridge.status().lastError).toContain("no session mapping");
    await harness.bridge.stop();
  });

  it("fails without prompting when the mapped session does not exist", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_missing" }], {
      readSession: async () => {
        throw new Error("session not found");
      },
    });
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);

    await harness.deliver(messageEvent());

    expect(harness.prompts).toHaveLength(0);
    expect(harness.bridge.deliveryStore.state("evd_1")).toBe("failed");
    await harness.bridge.stop();
  });

  it("does not prompt a second time when a completed delivery is redelivered", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);
    await harness.deliver(messageEvent());
    await harness.deliver(messageEvent());
    expect(harness.prompts).toHaveLength(1);
    await harness.bridge.stop();
  });

  it("posts the extracted assistant text back to the same thread", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);
    await harness.deliver(messageEvent({ threadId: "thr_1" }));
    expect(harness.prompts[0]?.content[0]?.text).toContain("thread_id: thr_1");

    harness.emit("ses_a", {
      type: "assistant/message",
      data: {
        message: {
          content: [
            { type: "text", text: "public answer" },
            { type: "tool-call", id: "call" },
          ],
        },
      },
    });
    harness.emit("ses_a", { type: "turn/end", data: { reason: { kind: "completed" } } });

    expect(harness.client.sent).toHaveLength(1);
    expect(harness.client.sent[0]).toMatchObject({
      groupId: "grp_a",
      content: "public answer",
      options: { threadId: "thr_1", replyToMessageId: "msg_1" },
    });
    await harness.bridge.stop();
  });

  it("does not reply for skip or a non-completed turn", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);
    await harness.deliver(messageEvent());
    harness.emit("ses_a", {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "[skip] no action" }] } },
    });
    harness.emit("ses_a", { type: "turn/end", data: { reason: { kind: "completed" } } });
    expect(harness.client.sent).toHaveLength(0);

    await harness.deliver(messageEvent({ eventId: "evd_2" }));
    harness.emit("ses_a", {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "partial" }] } },
    });
    harness.emit("ses_a", { type: "turn/end", data: { reason: { kind: "error" } } });
    expect(harness.client.sent).toHaveLength(0);
    await harness.bridge.stop();
  });

  it("keeps two groups isolated on two sessions", async () => {
    const harness = makeHarness([
      { groupId: "grp_a", sessionId: "ses_a" },
      { groupId: "grp_b", sessionId: "ses_b" },
    ]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);
    await harness.deliver(messageEvent({ groupId: "grp_a" }));
    await harness.deliver(messageEvent({ eventId: "evd_b", groupId: "grp_b" }));
    harness.emit("ses_a", {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "from a" }] } },
    });
    harness.emit("ses_a", { type: "turn/end", data: { reason: { kind: "completed" } } });
    expect(harness.client.sent).toEqual([
      expect.objectContaining({ groupId: "grp_a", content: "from a" }),
    ]);
    expect(harness.prompts.map((prompt) => prompt.sessionId)).toEqual(["ses_a", "ses_b"]);
    await harness.bridge.stop();
  });

  it("cancels the mapped session for a task.cancel command after recovery", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);
    harness.recover([
      { task: { id: "tsk_1", groupId: "grp_a" }, run: null, thread: null, workspace: null },
    ]);
    await harness.cancel({
      commandId: "cmd_1",
      type: "task.cancel",
      taskId: "tsk_1",
      runId: null,
      reason: "removed",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(harness.cancels).toEqual([{ sessionId: "ses_a" }]);
    await harness.bridge.stop();
  });

  it("persists completed state across a restart", async () => {
    const temp = mkdtempSync(join(tmpdir(), "room-dsh-plugin-"));
    const first = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }], { temp });
    await first.bridge.start();
    await waitFor(() => first.client.connected);
    await first.deliver(messageEvent());
    await first.bridge.stop();

    const second = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }], { temp });
    await second.bridge.start();
    await waitFor(() => second.client.connected);
    await second.deliver(messageEvent());
    expect(second.prompts).toHaveLength(0);
    await second.bridge.stop();
  });
});

describe("config, keys and delivery store", () => {
  it("rejects ambiguous group/session mappings", () => {
    expect(() =>
      assertMappings([
        { groupId: "g", sessionId: "s1", label: "" },
        { groupId: "g", sessionId: "s2", label: "" },
      ]),
    ).toThrow(/duplicate group/);
    expect(() =>
      assertMappings([
        { groupId: "g1", sessionId: "s", label: "" },
        { groupId: "g2", sessionId: "s", label: "" },
      ]),
    ).toThrow(/more than one group/);
  });

  it("creates and reloads a 0600 Ed25519 key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "room-dsh-key-"));
    const path = join(dir, "agent-key.pem");
    const first = await ensureAgentKey(path);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = await loadAgentKey(path);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(readFileSync(path, "utf8")).toContain("BEGIN PRIVATE KEY");

    chmodSync(path, 0o644);
    await expect(loadAgentKey(path)).rejects.toThrow(/chmod 600/);
  });

  it("writes delivery state atomically and reloads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "room-dsh-store-"));
    const path = join(dir, "deliveries.json");
    const store = new DeliveryStore(path);
    await store.load();
    await store.begin("evd_1");
    await store.markProcessing("evd_1");
    await store.markCompleted("evd_1");
    await store.markFailed("evd_2", "no mapping");

    const reloaded = new DeliveryStore(path);
    await reloaded.load();
    expect(reloaded.state("evd_1")).toBe("completed");
    expect(reloaded.get("evd_2")?.error).toBe("no mapping");
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
    writeFileSync(path, "{bad json");
    await expect(new DeliveryStore(path).load()).rejects.toThrow();
  });
});

describe("DSH plugin turn recovery", () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    eventId: "evd_recover",
    requestId: "room-evd_recover",
    sessionId: "ses_a",
    groupId: "grp_a",
    threadId: null as string | null,
    replyToMessageId: "msg_1",
    messageId: "msg_1",
    prompt: "[Agent Room message]\nhello room",
    text: "",
    state: "awaiting_response" as const,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  });

  async function seedTurn(harness: Harness, turn: Record<string, unknown>): Promise<void> {
    const store = new DeliveryStore(join(harness.temp, "deliveries.json"));
    await store.load();
    await store.recordTurn(turn as never);
  }

  it("posts the reply found in the session log after a restart", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }], {
      readSession: async () => ({
        events: [
          { type: "user/message", data: { turn: 3, source: { rpcId: "room-evd_recover" } } },
          {
            type: "assistant/message",
            data: { turn: 3, message: { content: [{ type: "text", text: "recovered answer" }] } },
          },
          { type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } },
        ],
      }),
    });
    await seedTurn(harness, record());
    await harness.bridge.start();
    await waitFor(() => harness.client.sent.length === 1);
    expect(harness.client.sent[0]?.content).toBe("recovered answer");
    expect(harness.client.sent[0]?.options?.clientMessageId).toBe("plugin-reply-evd_recover");
    expect(harness.bridge.deliveryStore.getTurn("evd_recover")?.state).toBe("completed");
    expect(harness.prompts).toHaveLength(0);
  });

  it("restores the waiter when the turn was still running", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }], {
      readSession: async () => ({
        events: [
          { type: "user/message", data: { turn: 4, source: { rpcId: "room-evd_recover" } } },
        ],
      }),
    });
    await seedTurn(harness, record());
    await harness.bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    harness.emit("ses_a", {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "late answer" }] } },
    } as never);
    harness.emit("ses_a", { type: "turn/end", data: { reason: { kind: "completed" } } });
    await waitFor(() => harness.client.sent.length === 1);
    expect(harness.client.sent[0]?.content).toBe("late answer");
  });

  it("does not replay a turn that already completed", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }]);
    await seedTurn(harness, record({ state: "completed", text: "done" }));
    await harness.bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(harness.client.sent).toHaveLength(0);
    expect(harness.prompts).toHaveLength(0);
  });

  it("correlates a turn with the rpcId of its user message", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);
    await harness.deliver(
      messageEvent({
        eventId: "evd_1",
        payload: { ...messageEvent().payload, messageId: "msg_1" },
      }),
    );
    await harness.deliver(
      messageEvent({
        eventId: "evd_2",
        payload: { ...messageEvent().payload, messageId: "msg_2" },
      }),
    );

    harness.emit("ses_a", {
      type: "user/message",
      data: { source: { rpcId: "room-evd_2" } },
    });
    harness.emit("ses_a", {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "second answer" }] } },
    });
    harness.emit("ses_a", { type: "turn/end", data: { reason: { kind: "completed" } } });

    await waitFor(() => harness.client.sent.length === 1);
    await waitFor(() => harness.bridge.deliveryStore.getTurn("evd_2")?.state === "completed");
    expect(harness.client.sent[0]).toMatchObject({
      content: "second answer",
      options: { replyToMessageId: "msg_2" },
    });
    expect(harness.bridge.deliveryStore.getTurn("evd_1")?.state).toBe("awaiting_response");
    await harness.bridge.stop();
  });

  it("persists task cancellation so a restart cannot resume the turn", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);
    await harness.deliver(messageEvent());
    harness.recover([{ task: { id: "tsk_1", groupId: "grp_a" } } as unknown as AgentTaskView]);
    await harness.cancel({
      commandId: "cmd_1",
      type: "task.cancel",
      taskId: "tsk_1",
      runId: null,
      reason: "removed",
      createdAt: new Date().toISOString(),
    });
    expect(harness.bridge.deliveryStore.getTurn("evd_1")?.state).toBe("cancelled");

    const reopened = new DeliveryStore(join(harness.temp, "deliveries.json"));
    await reopened.load();
    expect(reopened.getTurn("evd_1")?.state).toBe("cancelled");
    expect(reopened.listTurns(["prompting", "awaiting_response"])).toHaveLength(0);
    await harness.bridge.stop();
  });

  it("retries a reply generated while the socket was down after reconnect", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }]);
    await harness.bridge.start();
    await waitFor(() => harness.client.connected);
    await harness.deliver(messageEvent());
    harness.client.failSend = true;
    harness.emit("ses_a", {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "durable answer" }] } },
    });
    harness.emit("ses_a", { type: "turn/end", data: { reason: { kind: "completed" } } });
    await waitFor(() => harness.bridge.deliveryStore.getTurn("evd_1")?.state === "reply_pending");
    expect(harness.client.sent).toHaveLength(0);
    await harness.bridge.deliveryStore.flush();

    const second = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }], { temp: harness.temp });
    await second.bridge.start();
    await waitFor(() => second.client.sent.length === 1);
    expect(second.client.sent[0]).toMatchObject({
      content: "durable answer",
      options: { clientMessageId: "plugin-reply-evd_1" },
    });
    await waitFor(() => second.bridge.deliveryStore.getTurn("evd_1")?.state === "completed");
    await harness.bridge.stop();
    await second.bridge.stop();
  });

  it("does not open a connection or schedule reconnect after stop during connect", async () => {
    const harness = makeHarness([{ groupId: "grp_a", sessionId: "ses_a" }], {
      connectDelayMs: 60,
    });
    const starting = harness.bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.bridge.stop();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.client.openCalls).toBe(0);
    expect(harness.client.connected).toBe(false);
    expect(harness.bridge.status().connected).toBe(false);
  });
});
