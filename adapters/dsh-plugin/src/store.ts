import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export type DeliveryState = "pending" | "processing" | "completed" | "failed";

export interface DeliveryRecord {
  state: DeliveryState;
  attempts: number;
  updatedAt: string;
  error?: string;
}

export type TurnState =
  "prompting" | "awaiting_response" | "reply_pending" | "completed" | "failed" | "cancelled";

/** Durable association between one Room delivery and its DSH turn. */
export interface PendingTurnRecord {
  eventId: string;
  requestId: string;
  sessionId: string;
  groupId: string;
  threadId: string | null;
  replyToMessageId: string | null;
  messageId: string | null;
  prompt: string;
  text: string;
  state: TurnState;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface StoreFileV1 {
  version: 1;
  deliveries: Record<string, DeliveryRecord>;
}

interface StoreFileV2 {
  version: 2;
  deliveries: Record<string, DeliveryRecord>;
  turns: Record<string, PendingTurnRecord>;
}

const TERMINAL_TURN_STATES: ReadonlySet<TurnState> = new Set(["completed", "failed", "cancelled"]);

/**
 * Durable delivery and turn bookkeeping for the DSH plugin.
 *
 * All writes go through one promise chain: callers mutate the in-memory maps,
 * then queue a snapshot. Two concurrent updates therefore cannot interleave
 * their temporary files or overwrite each other's state. Temporary files carry
 * a unique suffix and are removed on load if a previous process crashed.
 */
export class DeliveryStore {
  private readonly filePath: string;
  private deliveries = new Map<string, DeliveryRecord>();
  private turns = new Map<string, PendingTurnRecord>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    await this.removeStaleTempFiles();
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFileV1 | StoreFileV2;
      if (parsed.version !== 1 && parsed.version !== 2) {
        throw new Error("unsupported delivery store format");
      }
      if (typeof parsed.deliveries !== "object" || !parsed.deliveries) {
        throw new Error("unsupported delivery store format");
      }
      for (const [eventId, record] of Object.entries(parsed.deliveries)) {
        if (!isDeliveryRecord(record)) {
          throw new Error(`invalid delivery record for ${eventId}`);
        }
        this.deliveries.set(eventId, record);
      }
      if (parsed.version === 2) {
        if (typeof parsed.turns !== "object" || !parsed.turns) {
          throw new Error("unsupported delivery store turn map");
        }
        for (const [eventId, turn] of Object.entries(parsed.turns)) {
          if (!isTurnRecord(turn)) throw new Error(`invalid turn record for ${eventId}`);
          this.turns.set(eventId, turn);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  get(eventId: string): DeliveryRecord | undefined {
    return this.deliveries.get(eventId);
  }

  state(eventId: string): DeliveryState | undefined {
    return this.deliveries.get(eventId)?.state;
  }

  counts(): Record<DeliveryState, number> {
    const counts: Record<DeliveryState, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };
    for (const record of this.deliveries.values()) counts[record.state] += 1;
    return counts;
  }

  turnCounts(): Record<TurnState, number> {
    const counts: Record<TurnState, number> = {
      prompting: 0,
      awaiting_response: 0,
      reply_pending: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const turn of this.turns.values()) counts[turn.state] += 1;
    return counts;
  }

  listTurns(states?: readonly TurnState[]): PendingTurnRecord[] {
    const allow = states ? new Set(states) : null;
    return [...this.turns.values()]
      .filter((turn) => !allow || allow.has(turn.state))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  getTurn(eventId: string): PendingTurnRecord | undefined {
    return this.turns.get(eventId);
  }

  async begin(eventId: string, now = new Date().toISOString()): Promise<DeliveryRecord> {
    this.assertLoaded();
    const existing = this.deliveries.get(eventId);
    const record: DeliveryRecord = {
      state: "pending",
      attempts: (existing?.attempts ?? 0) + 1,
      updatedAt: now,
    };
    this.deliveries.set(eventId, record);
    await this.commit();
    return record;
  }

  async markProcessing(eventId: string, now = new Date().toISOString()): Promise<void> {
    await this.updateDelivery(eventId, { state: "processing", updatedAt: now });
  }

  async markCompleted(eventId: string, now = new Date().toISOString()): Promise<void> {
    await this.updateDelivery(eventId, { state: "completed", updatedAt: now });
  }

  async markFailed(eventId: string, error: string, now = new Date().toISOString()): Promise<void> {
    await this.updateDelivery(eventId, { state: "failed", updatedAt: now, error });
  }

  async recordTurn(turn: PendingTurnRecord): Promise<void> {
    this.assertLoaded();
    this.turns.set(turn.eventId, turn);
    await this.commit();
  }

  async updateTurn(
    eventId: string,
    patch: Partial<Omit<PendingTurnRecord, "eventId">>,
  ): Promise<PendingTurnRecord | undefined> {
    this.assertLoaded();
    const existing = this.turns.get(eventId);
    if (!existing) return undefined;
    const updated: PendingTurnRecord = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.turns.set(eventId, updated);
    await this.commit();
    return updated;
  }

  /**
   * Drop old terminal records but never pending/processing/awaiting work. The
   * 30-day default is configurable; callers must keep the retention window
   * longer than any available server redelivery window.
   */
  async prune(options: { retentionDays?: number; now?: number } = {}): Promise<number> {
    this.assertLoaded();
    const retentionDays = options.retentionDays ?? 30;
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const now = options.now ?? Date.now();
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    let changed = false;
    let removed = 0;
    for (const [eventId, record] of this.deliveries) {
      if (
        (record.state === "completed" || record.state === "failed") &&
        record.updatedAt < cutoff
      ) {
        this.deliveries.delete(eventId);
        changed = true;
        removed += 1;
        // Non-terminal turns are never pruned: they are the durable record used
        // by restart recovery and by a redelivery to avoid a second prompt.
      }
    }
    for (const [eventId, turn] of this.turns) {
      if (!TERMINAL_TURN_STATES.has(turn.state)) continue;
      if (turn.updatedAt < cutoff) {
        this.turns.delete(eventId);
        changed = true;
        removed += 1;
      }
    }
    if (changed) await this.commit();
    return removed;
  }

  /** Wait for queued snapshots (used by tests and graceful stop). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async updateDelivery(
    eventId: string,
    patch: Omit<DeliveryRecord, "attempts"> & { attempts?: number },
  ): Promise<void> {
    this.assertLoaded();
    const existing = this.deliveries.get(eventId);
    this.deliveries.set(eventId, {
      attempts: existing?.attempts ?? 0,
      ...patch,
    });
    await this.commit();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("delivery store load() must be called first");
  }

  private commit(): Promise<void> {
    const run = this.writeChain.then(() => this.persist());
    // Keep the chain alive even when one snapshot fails; the caller still sees
    // the rejection through the returned promise.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const payload: StoreFileV2 = {
      version: 2,
      deliveries: Object.fromEntries(
        [...this.deliveries.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      turns: Object.fromEntries([...this.turns.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.filePath);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  private async removeStaleTempFiles(): Promise<void> {
    const directory = dirname(this.filePath);
    const prefix = `${basename(this.filePath)}.`;
    try {
      for (const entry of await readdir(directory)) {
        if (entry.startsWith(prefix) && entry.endsWith(".tmp")) {
          await unlink(`${directory}/${entry}`).catch(() => undefined);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function isDeliveryRecord(value: unknown): value is DeliveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as DeliveryRecord;
  return (
    (record.state === "pending" ||
      record.state === "processing" ||
      record.state === "completed" ||
      record.state === "failed") &&
    typeof record.attempts === "number" &&
    typeof record.updatedAt === "string" &&
    (record.error === undefined || typeof record.error === "string")
  );
}

function isTurnRecord(value: unknown): value is PendingTurnRecord {
  if (!value || typeof value !== "object") return false;
  const turn = value as PendingTurnRecord;
  return (
    (turn.state === "prompting" ||
      turn.state === "awaiting_response" ||
      turn.state === "reply_pending" ||
      turn.state === "completed" ||
      turn.state === "failed" ||
      turn.state === "cancelled") &&
    typeof turn.eventId === "string" &&
    typeof turn.requestId === "string" &&
    typeof turn.sessionId === "string" &&
    typeof turn.groupId === "string" &&
    (turn.threadId === null || typeof turn.threadId === "string") &&
    (turn.replyToMessageId === null || typeof turn.replyToMessageId === "string") &&
    (turn.messageId === null || typeof turn.messageId === "string") &&
    typeof turn.prompt === "string" &&
    typeof turn.text === "string" &&
    typeof turn.createdAt === "string" &&
    typeof turn.updatedAt === "string" &&
    (turn.error === undefined || typeof turn.error === "string")
  );
}
