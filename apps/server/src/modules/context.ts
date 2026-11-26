import type { DatabaseHandle } from "@room/database";
import type { RealtimeHub } from "./realtime.js";

export type RoomDb = DatabaseHandle["db"];

export interface RoomContext {
  readonly handle: DatabaseHandle;
  readonly db: RoomDb;
  readonly now: () => number;
  /** Optional live browser-socket registry for permission revocation. */
  readonly realtime?: RealtimeHub;
}

export function createRoomContext(
  handle: DatabaseHandle,
  now: () => number = Date.now,
  realtime?: RealtimeHub,
): RoomContext {
  return { handle, db: handle.db, now, realtime };
}
