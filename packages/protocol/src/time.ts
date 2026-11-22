export function nowMs(): number {
  return Date.now();
}

/** The API always exposes timestamps as ISO 8601 UTC strings (plan §6.2). */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function fromIso(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO timestamp: ${value}`);
  return ms;
}
