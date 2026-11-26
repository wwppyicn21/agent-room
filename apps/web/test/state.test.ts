import { describe, expect, it } from "vitest";
import type { Message } from "../src/api";
import { mergeMessages, removeById, replaceById, upsertById } from "../src/state";

function message(id: string, seq: number, content = id): Message {
  return {
    id,
    groupId: "grp_1",
    threadId: null,
    senderType: "user",
    senderId: "usr_1",
    content,
    rootMessageId: null,
    replyToMessageId: null,
    hop: 0,
    seq,
    createdAt: seq,
  };
}

describe("web state helpers", () => {
  it("merges by id keeps the newest copy and sorts by seq", () => {
    const merged = mergeMessages(
      [message("msg_b", 2), message("msg_a", 1)],
      [message("msg_b", 2, "updated"), message("msg_c", 3)],
    );
    expect(merged.map((item) => item.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
    expect(merged[1].content).toBe("updated");
  });

  it("upserts, replaces and removes entities by id", () => {
    const initial = [{ id: "a", value: 1 }];
    expect(upsertById(initial, { id: "b", value: 2 })).toHaveLength(2);
    expect(replaceById(initial, { id: "a", value: 9 })[0].value).toBe(9);
    expect(removeById(initial, "a")).toEqual([]);
  });
});
