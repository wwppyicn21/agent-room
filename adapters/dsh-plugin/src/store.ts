import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DeliveryState = "pending" | "processing" | "completed" | "failed";

export interface DeliveryRecord {
  state: DeliveryState;
  attempts: number;
  updatedAt: string;
  error?: string;
}

interface StoreFile {
  version: 1;
  deliveries: Record<string, DeliveryRecord>;
}

/**
 * Durable delivery bookkeeping. The Room server may redeliver an event after a
 * dropped ack or a reconnect; state is persisted to disk (atomically) so a
 * plugin restart never relies on an in-memory Set for deduplication.
 */
export class DeliveryStore {
  private readonly filePath: string;
  private deliveries = new Map<string, DeliveryRecord>();
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed.version !== 1 || typeof parsed.deliveries !== "object" || !parsed.deliveries) {
        throw new Error("unsupported delivery store format");
      }
      for (const [eventId, record] of Object.entries(parsed.deliveries)) {
        if (!isDeliveryRecord(record)) {
          throw new Error(`invalid delivery record for ${eventId}`);
        }
        this.deliveries.set(eventId, record);
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

  async begin(eventId: string, now = new Date().toISOString()): Promise<DeliveryRecord> {
    this.assertLoaded();
    const existing = this.deliveries.get(eventId);
    const record: DeliveryRecord = {
      state: "pending",
      attempts: (existing?.attempts ?? 0) + 1,
      updatedAt: now,
    };
    this.deliveries.set(eventId, record);
    await this.persist();
    return record;
  }

  async markProcessing(eventId: string, now = new Date().toISOString()): Promise<void> {
    await this.update(eventId, { state: "processing", updatedAt: now });
  }

  async markCompleted(eventId: string, now = new Date().toISOString()): Promise<void> {
    await this.update(eventId, { state: "completed", updatedAt: now });
  }

  async markFailed(eventId: string, error: string, now = new Date().toISOString()): Promise<void> {
    await this.update(eventId, { state: "failed", updatedAt: now, error });
  }

  private async update(
    eventId: string,
    patch: Omit<DeliveryRecord, "attempts"> & { attempts?: number },
  ): Promise<void> {
    this.assertLoaded();
    const existing = this.deliveries.get(eventId);
    this.deliveries.set(eventId, {
      attempts: existing?.attempts ?? 0,
      ...patch,
    });
    await this.persist();
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("delivery store load() must be called first");
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const payload: StoreFile = {
      version: 1,
      deliveries: Object.fromEntries(
        [...this.deliveries.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.filePath);
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
