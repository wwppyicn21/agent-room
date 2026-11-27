import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, messageFromEvent } from "../src/api";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function client(handler: (call: Call) => Response): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const api = new ApiClient({
    devEmail: "owner@example.com",
    fetchImpl: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return handler(call);
    },
  });
  return { api, calls };
}

describe("web api client", () => {
  it("attaches the dev user header and parses results", async () => {
    const { api, calls } = client(
      () => new Response(JSON.stringify({ authMode: "dev" }), { status: 200 }),
    );
    await expect(api.authInfo()).resolves.toEqual({ authMode: "dev" });
    expect(calls[0].url).toBe("/api/v1/auth-info");
    expect(new Headers(calls[0].init?.headers).get("x-dev-user-email")).toBe("owner@example.com");
  });

  it("maps error responses to ApiError", async () => {
    const { api } = client(
      () =>
        new Response(JSON.stringify({ error: { code: "conflict", message: "nope" } }), {
          status: 409,
        }),
    );
    await expect(api.getGroup("grp_1")).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      message: "nope",
    });
    await expect(api.getGroup("grp_1")).rejects.toBeInstanceOf(ApiError);
  });

  it("encodes numeric message cursors and string event cursors", async () => {
    const { api, calls } = client(
      () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    await api.listMessages("grp_1", { cursor: 42, limit: 50 });
    const messageUrl = new URL(calls[0].url, "http://localhost");
    expect(messageUrl.pathname).toBe("/api/v1/groups/grp_1/messages");
    expect(messageUrl.searchParams.get("limit")).toBe("50");
    expect(messageUrl.searchParams.get("cursor")).toBe("42");
    await api.listEvents("grp_1", { cursor: "evt_9" });
    expect(calls[1].url).toBe("/api/v1/groups/grp_1/events?cursor=evt_9");
  });

  it("converts realtime message.created events into messages", () => {
    const event = {
      seq: 7,
      id: "evt_1",
      type: "message.created",
      groupId: "grp_1",
      threadId: null,
      taskId: null,
      actorType: "user" as const,
      actorId: "usr_1",
      payload: JSON.stringify({
        messageId: "msg_1",
        content: "hello",
        senderType: "user",
        senderId: "usr_1",
        seq: 7,
      }),
      createdAt: 100,
    };
    expect(messageFromEvent(event, "grp_1")?.content).toBe("hello");
    expect(messageFromEvent({ ...event, type: "task.created" }, "grp_1")).toBeNull();
  });

  it("keeps the nested delivery diagnostics DTO intact", async () => {
    const { api } = client(
      () =>
        new Response(
          JSON.stringify({
            items: [
              {
                delivery: {
                  id: "dly_1",
                  agentId: "agt_1",
                  eventId: "evt_1",
                  status: "pending",
                  attempts: 2,
                  createdAt: 100,
                  deliveredAt: null,
                  ackedAt: null,
                  failedAt: null,
                },
                agentDisplayName: "dsh",
                eventType: "message.created",
              },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        ),
    );
    const result = await api.listDeliveries("grp_1");
    expect(result.items[0].delivery.id).toBe("dly_1");
    expect(result.items[0].agentDisplayName).toBe("dsh");
    expect(result.items[0].eventType).toBe("message.created");
  });
});
