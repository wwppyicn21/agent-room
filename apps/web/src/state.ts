import type { Message } from "./api";

/** Merge messages by id, keeping the newest copy and ordering by seq. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

export function replaceById<T extends { id: string }>(items: T[], next: T): T[] {
  return items.map((item) => (item.id === next.id ? next : item));
}

export function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}
