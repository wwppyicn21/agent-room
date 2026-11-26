import { describe, expect, it, vi } from "vitest";
import { ApiClient, type EventRow } from "../src/api";
import { RealtimeClient } from "../src/realtime";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("web realtime client", () => {
  it("opens a ticket, subscribes after the cursor and dispatches frames", async () => {
    const events: EventRow[] = [];
    const presence: string[] = [];
    (globalThis as unknown as Record<string, unknown>).window = {
      location: { protocol: "http:", host: "127.0.0.1:5173" },
    };
    (globalThis as unknown as Record<string, unknown>).WebSocket = FakeSocket;
    const api = new ApiClient({
      fetchImpl: async () =>
        new Response(JSON.stringify({ ticket: "tkt_1", expiresAt: 100 }), { status: 200 }),
    });
    const client = new RealtimeClient(
      api,
      "grp_1",
      {
        onEvent: (event) => events.push(event),
        onPresence: (frame) => presence.push(...frame.agents.map((agent) => agent.agentId)),
        onState: () => vi.fn(),
      },
      5,
    );
    client.connect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const socket = FakeSocket.instances.at(-1);
    expect(socket?.url).toBe("ws://127.0.0.1:5173/api/v1/realtime/ws?ticket=tkt_1");
    socket?.onopen?.();
    expect(socket?.sent[0]).toEqual({ type: "subscribe", groupId: "grp_1", afterSeq: 5 });

    const event: EventRow = {
      seq: 6,
      id: "evt_6",
      type: "message.created",
      groupId: "grp_1",
      threadId: null,
      taskId: null,
      actorType: "user",
      actorId: "usr_1",
      payload: "{}",
      createdAt: 6,
    };
    socket?.onmessage?.({ data: JSON.stringify({ type: "event", event }) });
    socket?.onmessage?.({
      data: JSON.stringify({
        type: "presence",
        groupId: "grp_1",
        agents: [{ agentId: "agt_1", displayName: "A", status: "offline", online: true }],
      }),
    });
    expect(events.map((item) => item.id)).toEqual(["evt_6"]);
    expect(presence).toEqual(["agt_1"]);
    client.close();
  });
});
