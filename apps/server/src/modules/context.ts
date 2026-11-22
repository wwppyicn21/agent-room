import type { DatabaseHandle } from "@room/database";

export type RoomDb = DatabaseHandle["db"];

export interface RoomContext {
  readonly handle: DatabaseHandle;
  readonly db: RoomDb;
  readonly now: () => number;
}

export function createRoomContext(
  handle: DatabaseHandle,
  now: () => number = Date.now,
): RoomContext {
  return { handle, db: handle.db, now };
}
